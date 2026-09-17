import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

// A static host serves one prebuilt 404.html for every unknown URL, and the
// client router is what rewrites that page's state to the URL the visitor
// asked for. An app whose 404 shows fixed markup does not need it — and the
// router is routinely the largest chunk in an otherwise islands-only build,
// requested by 404.html and nothing else. This builds examples/static with
// `notFound: { hydration: "none" }` and proves the emitted 404 ships no
// JavaScript at all.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/static");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("a static notFound page can opt out of the client router", async () => {
  test.setTimeout(120_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-static-404-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });

    // Only the not-found page changes: every other route, SPA ones included,
    // stays exactly as the example ships it.
    const routesPath = resolve(exampleDir, "src/routes.ts");
    const routes = readFileSync(routesPath, "utf-8").replace(
      '    shell: "site",\n  },',
      '    shell: "site",\n    hydration: "none",\n  },',
    );
    expect(routes).toContain('hydration: "none"');
    writeFileSync(routesPath, routes, "utf-8");

    // `useLocation()` reports the synthetic build-time path without the
    // router, so the page that opts out must not ask for the URL.
    writeFileSync(
      resolve(exampleDir, "src/routes/not-found.tsx"),
      [
        "export function loader() {",
        '  return { message: "Built custom 404" };',
        "}",
        "",
        "export function Component({ data }: { data: { message: string } }) {",
        "  return (",
        '    <section id="not-found">',
        "      <h1>404 — page not found</h1>",
        '      <p id="not-found-data">{data.message}</p>',
        '      <a href="/">Back home</a>',
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
      stdio: "pipe",
    });

    const notFoundHtml = readFileSync(resolve(exampleDir, "dist/client/404.html"), "utf-8");

    expect(notFoundHtml).toContain("404 — page not found");
    expect(notFoundHtml).toContain("Built custom 404");
    // No client entry, no hydration state, no script of any kind.
    expect(notFoundHtml).not.toContain("<script");
    expect(notFoundHtml).not.toContain('id="pracht-state"');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
