import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { e2eExampleDirectory } from "./ports.ts";

// Development and production resolve a page's CSS through different machinery:
// dev walks Vite's live SSR module graph, the build reads a manifest assembled
// from two bundles. They are supposed to reach the same answer, and when they
// drift it is production that loses — silently, because the page still renders
// and only the rules are gone.
//
// So compare them on what actually matters: the class names a page has rules
// for in its *initial document*, before any JavaScript runs. Stylesheets that
// arrive later cannot prevent the unstyled first paint this guards against.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const devFixtureDir = e2eExampleDirectory("islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

const PAGES = ["/", "/lazy", "/static", "/static-island"];

const LINK_RE = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;
const HREF_RE = /\bhref="([^"]+)"/;
const INLINE_RE = /<style data-pracht-inline-css[^>]*>([\s\S]*?)<\/style>/g;
const CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;

function classNames(css: string): Set<string> {
  return new Set([...css.matchAll(CLASS_RE)].map((match) => match[1]!));
}

function stylesheetHrefs(html: string): string[] {
  return [...html.matchAll(LINK_RE)].map((match) => match[0].match(HREF_RE)?.[1] ?? "");
}

/** Everything the document itself carries, resolved against a directory of files. */
function documentCss(html: string, readHref: (href: string) => string): string {
  const inline = [...html.matchAll(INLINE_RE)].map((match) => match[1]!);
  return [...inline, ...stylesheetHrefs(html).map(readHref)].join("\n");
}

test("a page has the same rules in dev as it ships with", async ({ page }) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-islands-css-parity-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
      stdio: "pipe",
    });

    for (const path of PAGES) {
      // Dev links the source stylesheets Vite serves, so they are read from the
      // fixture; the example styles with plain CSS, which keeps class names
      // identical on both sides.
      const devHtml = (await (await page.goto(path))?.text()) ?? "";
      const devCss = documentCss(devHtml, (href) => {
        const source = href.startsWith("/@fs/") ? href.slice("/@fs".length) : href;
        expect(source, `${path} links a stylesheet outside the project: ${href}`).toMatch(/^\//);
        return readFileSync(
          source.startsWith("/src/") ? resolve(devFixtureDir, source.slice(1)) : source,
          "utf-8",
        );
      });

      const builtHtml = readFileSync(
        resolve(exampleDir, `dist/client${path === "/" ? "" : path}/index.html`),
        "utf-8",
      );
      const builtCss = documentCss(builtHtml, (href) =>
        readFileSync(resolve(exampleDir, `dist/client${href}`), "utf-8"),
      );

      const inDev = classNames(devCss);
      const inBuild = classNames(builtCss);
      expect(
        [...inDev].filter((name) => !inBuild.has(name)).sort(),
        `${path} has rules in dev that the build drops`,
      ).toEqual([]);
      expect(
        [...inBuild].filter((name) => !inDev.has(name)).sort(),
        `${path} ships rules dev never shows`,
      ).toEqual([]);
    }

    // The comparison is only worth something if the pages have rules to compare
    // and differ from one another; an empty set matches an empty set.
    const homeCss = documentCss((await (await page.goto("/"))?.text()) ?? "", (href) =>
      readFileSync(resolve(devFixtureDir, href.slice(1)), "utf-8"),
    );
    expect([...classNames(homeCss)].sort()).toEqual(["card", "counter", "site-shell"]);

    const lazyCss = documentCss((await (await page.goto("/lazy"))?.text()) ?? "", (href) =>
      readFileSync(resolve(devFixtureDir, href.slice(1)), "utf-8"),
    );
    expect(classNames(lazyCss).has("lazy-box")).toBe(true);
    expect(classNames(lazyCss).has("counter")).toBe(false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
