// `scripts/sync-docs.js` (via `scripts/docs-bundle.js`) copies the public docs site pages into the CLI
// package. Its output is what `pracht docs` and the dev-mcp docs tools serve,
// so the link rewriting and the file selection are tested here directly.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, createTempDir, repoRoot } from "./helpers/cli-fixtures.js";
import {
  buildDocsBundle,
  parseNavSections,
  rewriteLinks,
  routeForSlug,
  splitFrontmatter,
  writeDocsBundle,
} from "../scripts/docs-bundle.js";

afterEach(cleanupTempDirs);

const siteDocs = resolve(repoRoot, "examples/docs/src/routes/docs");
const siteShell = resolve(repoRoot, "examples/docs/src/shells/docs.tsx");

function sourceDir(pages) {
  const dir = createTempDir("pracht-sync-docs-");
  for (const [name, body] of Object.entries(pages)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("sync-docs", () => {
  it("bundles every site page, and nothing else", () => {
    const { pages } = buildDocsBundle({ sourceDir: siteDocs, shellFile: siteShell });
    const sitePages = readdirSync(siteDocs)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3));

    expect(pages.map((page) => page.slug).sort()).toEqual(sitePages.sort());
    expect(pages.some((page) => page.slug === "index")).toBe(false);
    // Every page has a sidebar section, so a page missing from the nav is caught.
    expect(pages.filter((page) => page.section === "Other").map((page) => page.slug)).toEqual([]);
  });

  it("leaves no site-relative link that would not resolve offline", () => {
    const { pages } = buildDocsBundle({ sourceDir: siteDocs, shellFile: siteShell });
    const slugs = new Set(pages.map((page) => page.slug));
    const broken = [];

    for (const page of pages) {
      const prose = page.markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)/g)) {
        if (target.startsWith("/")) broken.push(`${page.slug}: ${target}`);
        const sibling = /^([a-z0-9-]+)\.md(?:#|$)/.exec(target);
        if (sibling && !slugs.has(sibling[1])) broken.push(`${page.slug}: ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it("rewrites docs links to sibling files and other site paths to absolute URLs", () => {
    const pathToSlug = new Map([
      [routeForSlug("routing"), "routing"],
      [routeForSlug("recipes-auth"), "recipes-auth"],
    ]);
    const body = [
      "See [routing](/docs/routing#route-manifest) and [auth](/docs/recipes/auth/).",
      "The [index](/docs), [skills](/.well-known/agent-skills/index.json), and [here](#local).",
      'An [external](https://example.com/docs/x) link, an ![image](./shot.jpg "Title").',
      'Inline `[code](/docs/routing)` and <a href="/docs/routing">html</a>.',
      "[ref]: /docs/recipes/auth",
      "```md",
      "[fenced](/docs/routing)",
      "```",
    ].join("\n");

    const out = rewriteLinks(body, pathToSlug);

    expect(out).toContain("[routing](routing.md#route-manifest)");
    expect(out).toContain("[auth](recipes-auth.md)");
    expect(out).toContain("[index](https://pracht.resynapse.dev/docs)");
    expect(out).toContain(
      "[skills](https://pracht.resynapse.dev/.well-known/agent-skills/index.json)",
    );
    expect(out).toContain("[here](#local)");
    expect(out).toContain("[external](https://example.com/docs/x)");
    expect(out).toContain(
      '![image](https://github.com/JoviDeCroock/pracht/blob/main/examples/docs/src/routes/docs/shot.jpg "Title")',
    );
    expect(out).toContain("`[code](/docs/routing)`");
    expect(out).toContain('<a href="routing.md">html</a>');
    expect(out).toContain("[ref]: recipes-auth.md");
    expect(out).toContain("[fenced](/docs/routing)");
  });

  it("reads Windows line endings, a BOM, and quoted frontmatter", () => {
    const dir = sourceDir({
      "crlf.md":
        "﻿---\r\ntitle: \"Quoted: title\"\r\nlead: 'It''s a lead'\r\nprev:\r\n  href: /docs/x\r\n---\r\n\r\n## Body\r\n",
    });

    const [page] = buildDocsBundle({ sourceDir: dir }).pages;

    expect(page).toMatchObject({ slug: "crlf", title: "Quoted: title", lead: "It's a lead" });
    expect(page.markdown).not.toContain("\r");
    expect(page.markdown).not.toContain("prev:");
    expect(page.markdown).toContain("## Body");
  });

  it("only copies .md pages and rejects names it cannot serve", () => {
    const dir = sourceDir({
      "good.md": "---\ntitle: Good\n---\n",
      "index.tsx": "export {}",
      "image.jpg": "jpg",
    });
    expect(buildDocsBundle({ sourceDir: dir }).pages.map((page) => page.slug)).toEqual(["good"]);

    expect(() =>
      buildDocsBundle({ sourceDir: sourceDir({ "index.md": "---\ntitle: I\n---\n" }) }),
    ).toThrow(/unsupported file name/);
    expect(() =>
      buildDocsBundle({ sourceDir: sourceDir({ "Bad Name.md": "---\ntitle: B\n---\n" }) }),
    ).toThrow(/unsupported file name/);
    expect(() => buildDocsBundle({ sourceDir: sourceDir({ "untitled.md": "# Hi\n" }) })).toThrow(
      /no frontmatter title/,
    );
  });

  it("replaces the previous bundle, so a removed page disappears", () => {
    const target = join(createTempDir("pracht-sync-docs-out-"), "docs");
    writeDocsBundle(
      buildDocsBundle({ sourceDir: sourceDir({ "old.md": "---\ntitle: Old\n---\n" }) }),
      target,
    );
    writeDocsBundle(
      buildDocsBundle({ sourceDir: sourceDir({ "new.md": "---\ntitle: New\n---\n" }) }),
      target,
    );

    expect(existsSync(join(target, "old.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(target, "index.json"), "utf-8")).pages).toEqual([
      expect.objectContaining({ slug: "new", path: "/docs/new", section: "Other" }),
    ]);
    expect(readFileSync(join(target, "index.md"), "utf-8")).toContain("- [New](new.md)");
  });

  it("reads sidebar sections in order", () => {
    const sections = parseNavSections(readFileSync(siteShell, "utf-8"));

    expect(sections[0].label).toBe("Getting Started");
    expect(sections.flatMap((section) => section.paths)).toContain("/docs/recipes/auth");
  });

  it("splits frontmatter without a closing fence as body", () => {
    expect(splitFrontmatter("# No frontmatter\n")).toEqual({
      fields: {},
      body: "# No frontmatter\n",
    });
  });
});
