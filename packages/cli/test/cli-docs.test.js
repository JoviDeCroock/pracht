// `pracht docs` serves the docs pages bundled into the package at build time
// (`scripts/sync-docs.js`), so an agent reads the documentation that matches
// the installed CLI. These tests run the real binary against the real bundle,
// from a directory that is not a pracht app: the command must not need one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, createTempDir, runCliStatus } from "./helpers/cli-fixtures.js";
import { extractDocsSection, loadDocsIndex, matchDocsTopic, searchDocs } from "../src/docs.ts";
import { buildDocsBundle, writeDocsBundle } from "../scripts/docs-bundle.js";

afterEach(cleanupTempDirs);

function docs(args) {
  return runCliStatus(["docs", ...args], { cwd: createTempDir("pracht-docs-cli-") });
}

/** A small bundle written by the real sync script, for runtime edge cases. */
function writeFixtureBundle(pages) {
  const source = createTempDir("pracht-docs-src-");
  for (const [name, body] of Object.entries(pages)) writeFileSync(join(source, name), body);
  const target = join(createTempDir("pracht-docs-out-"), "docs");
  writeDocsBundle(buildDocsBundle({ sourceDir: source }), target);
  return target;
}

describe("pracht docs", () => {
  it("lists the bundled pages outside a pracht app", () => {
    const result = docs([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/pracht docs for @pracht\/cli \d+\.\d+\.\d+ — \d+ pages\./);
    expect(result.stdout).toMatch(/^ {2}routing +Routing — /m);
    expect(result.stdout).toContain("\nGetting Started\n");
  });

  it("lists pages as JSON", () => {
    const result = docs(["--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const routing = payload.pages.find((page) => page.slug === "routing");
    expect(routing).toMatchObject({
      path: "/docs/routing",
      url: "https://pracht.resynapse.dev/docs/routing",
      title: "Routing",
      section: "Getting Started",
    });
    expect(payload.pages.find((page) => page.slug === "recipes-auth")?.path).toBe(
      "/docs/recipes/auth",
    );
  });

  it("prints a page by slug, site path, file name, or unique word", () => {
    for (const topic of ["routing", "/docs/routing", "routing.md", "Routing"]) {
      const result = docs([topic]);
      expect(result.status, topic).toBe(0);
      expect(result.stdout, topic).toMatch(/^---\ntitle: "Routing"\n/);
    }

    expect(docs(["recipes/auth"]).stdout).toMatch(/^---\ntitle: "Authentication"/);
    expect(docs(["nextjs"]).stdout).toMatch(/^---\ntitle: "Migrating from Next\.js"/);
    expect(docs(["view", "transitions"]).stdout).toMatch(/^---\ntitle: "View Transitions"/);
  });

  it("rewrites site links to sibling pages so they resolve offline", () => {
    const page = docs(["cli"]).stdout;

    expect(page).not.toMatch(/\]\(\/docs\//);
    expect(page).toContain("](coding-agents.md#");
    expect(page).toContain("url: https://pracht.resynapse.dev/docs/cli");
  });

  it("prints one section with slug#anchor", () => {
    const result = docs(["routing#route-manifest"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^## Route Manifest\n/);
    expect(result.stdout).not.toContain("title:");
  });

  it("fails with a suggestion for an unknown topic", () => {
    const typo = docs(["rooting"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('Unknown docs topic "rooting". Did you mean routing');

    const ambiguous = docs(["i18n"]);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain("It matches several pages: recipes-i18n, reference-i18n");

    const section = docs(["routing#no-such-section"]);
    expect(section.status).toBe(1);
    expect(section.stderr).toContain('No section "#no-such-section"');
    expect(section.stderr).toContain("route-manifest");
  });

  it("never reads outside the bundled pages", () => {
    for (const topic of ["../../package", "../package.json", "/etc/passwd", "..\\..\\package"]) {
      const result = docs([topic]);
      expect(result.status, topic).toBe(1);
      expect(result.stdout, topic).toBe("");
      expect(result.stderr, topic).toContain("Unknown docs topic");
    }
  });

  it("searches headings and prose", () => {
    const result = docs(["--search", "route", "manifest"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("routing#route-manifest");

    const json = JSON.parse(docs(["--search", "loader", "--json"]).stdout);
    expect(json.query).toBe("loader");
    expect(json.results.length).toBeGreaterThan(0);
    expect(json.results[0]).toMatchObject({
      slug: expect.any(String),
      heading: expect.any(String),
      anchor: expect.any(String),
      snippet: expect.any(String),
    });
  });

  it("rejects an empty search and reports no matches", () => {
    for (const args of [["--search"], ["--search", ""], ["--search", "  "]]) {
      const result = docs(args);
      expect(result.status, JSON.stringify(args)).toBe(1);
      expect(result.stderr).toContain("Pass a search query");
    }

    const none = docs(["--search", "zzzqqqxx"]);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('No docs match "zzzqqqxx"');
  });

  it("reports an error as JSON with --json", () => {
    const result = docs(["nope-nope", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });
});

describe("bundled docs runtime", () => {
  it("explains a missing bundle instead of throwing ENOENT", () => {
    const empty = createTempDir("pracht-docs-missing-");

    expect(() => loadDocsIndex(empty)).toThrow(/bundled pracht docs are missing.*pnpm build/);
    expect(() => searchDocs("loader", { dir: empty })).toThrow(/bundled pracht docs are missing/);
  });

  it("explains a corrupt index", () => {
    const dir = createTempDir("pracht-docs-corrupt-");
    writeFileSync(join(dir, "index.json"), "{not json");

    expect(() => loadDocsIndex(dir)).toThrow(/index is unreadable/);
  });

  it("drops index entries whose slug could address another file", () => {
    const dir = createTempDir("pracht-docs-evil-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        pages: [
          { slug: "../../package", title: "Evil", path: "/docs/x", url: "", lead: "", section: "" },
          { slug: "ok", title: "Ok", path: "/docs/ok", url: "", lead: "", section: "" },
        ],
      }),
    );

    expect(loadDocsIndex(dir).pages.map((page) => page.slug)).toEqual(["ok"]);
  });

  it("matches anchors for duplicate headings the way the site numbers them", () => {
    const dir = writeFixtureBundle({
      "alpha.md":
        "---\ntitle: Alpha\n---\n\n## Setup\n\nfirst\n\n## Other\n\n### Setup\n\nsecond\n",
    });
    const index = loadDocsIndex(dir);
    const match = matchDocsTopic(index, "alpha#setup-1");
    expect(match.ok).toBe(true);

    const hits = searchDocs("second", { dir, index });
    expect(hits[0]).toMatchObject({ slug: "alpha", anchor: "setup-1" });

    const page = `---\ntitle: x\n---\n\n## Setup\n\n\`\`\`md\n## Not a heading\n\`\`\`\n\n## Next\n`;
    const section = extractDocsSection(page, "setup");
    expect(section.ok && section.markdown).toContain("## Not a heading");
    expect(section.ok && section.markdown).not.toContain("## Next");
  });
});
