// `pracht docs` serves the docs pages bundled into the package at build time.
// Lookup, search, and anchors are tested in-process against a small fixture
// bundle written by the real bundler (`scripts/docs-bundle.js`), so the tests
// neither depend on build output nor break when a site page is edited. One
// smoke test runs the real binary against the real bundle.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, createTempDir, runCliStatus } from "./helpers/cli-fixtures.js";
import { runDocsCommand } from "../src/commands/docs.ts";
import { extractDocsSection, loadDocsIndex, matchDocsTopic, searchDocs } from "../src/docs.ts";
import { buildDocsBundle, writeDocsBundle } from "../scripts/docs-bundle.js";

afterEach(cleanupTempDirs);

const FIXTURE_PAGES = {
  "routing.md": [
    "---",
    "title: Routing",
    "lead: Routes are declared in a manifest.",
    "---",
    "",
    "## Route Manifest",
    "",
    "Declare every route in `src/routes.ts`. See [loaders](/docs/data-loading#loaders).",
    "",
    "## `<Link>` props",
    "",
    "Link takes a route id.",
    "",
    "## `href` is not a `<Link>` prop",
    "",
    "Use route ids.",
    "",
    "## Setup",
    "",
    "first setup",
    "",
    "## Pages",
    "",
    "### Setup",
    "",
    "second setup",
    "",
  ].join("\n"),
  "data-loading.md": [
    "---",
    "title: Data Loading",
    "lead: Loaders run on the server.",
    "---",
    "",
    "## Loaders",
    "",
    "A loader runs on the server and returns serializable data.",
    "",
    "```ts",
    "export async function loader() { return { loader: 'loader loader loader' }; }",
    "```",
    "",
    "## Downloading files",
    "",
    "Stream a download from an API route.",
    "",
  ].join("\n"),
  "recipes-auth.md": [
    "---",
    "title: Authentication",
    "lead: Sessions and protected routes.",
    "---",
    "",
    "## Add auth middleware",
    "",
    "Gate protected routes with an auth middleware that reads the session.",
    "",
    "## OAuth providers",
    "",
    "Sign in with an oauth provider.",
    "",
  ].join("\n"),
  "recipes-i18n.md": "---\ntitle: i18n Recipe\n---\n\n## Locales\n\nTranslate pages.\n",
  "reference-i18n.md": "---\ntitle: i18n Reference\n---\n\n## API\n\nThe i18n API.\n",
  "migrate-nextjs.md": "---\ntitle: Migrating from Next.js\n---\n\n## Pages\n\nMove pages.\n",
  "demo-comparison.md": "---\ntitle: A full pracht app, end to end\n---\n\n## Tour\n\nA tour.\n",
};

const FIXTURE_SHELL = `const NAV = [
  { label: "Getting Started", links: [{ href: "/docs/routing" }, { href: "/docs/demo-comparison" }] },
  { label: "Core", links: [{ href: "/docs/data-loading" }] },
  { label: "Recipes", links: [{ href: "/docs/recipes/auth" }, { href: "/docs/recipes/i18n" }] },
];
`;

function writeFixtureBundle() {
  const source = createTempDir("pracht-docs-src-");
  for (const [name, body] of Object.entries(FIXTURE_PAGES)) {
    writeFileSync(join(source, name), body);
  }
  const shellFile = join(createTempDir("pracht-docs-shell-"), "docs.tsx");
  writeFileSync(shellFile, FIXTURE_SHELL);
  const target = join(createTempDir("pracht-docs-out-"), "docs");
  writeDocsBundle(buildDocsBundle({ sourceDir: source, shellFile }), target);
  return target;
}

function docs(dir, topic, options = {}) {
  return runDocsCommand({ topic, ...options }, { dir, version: "9.9.9" });
}

describe("pracht docs (fixture bundle)", () => {
  it("lists pages by sidebar section", () => {
    const dir = writeFixtureBundle();
    const result = docs(dir, []);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^pracht docs for @pracht\/cli 9\.9\.9 — 7 pages\./);
    expect(result.stdout).toMatch(/\nGetting Started\n {2}routing +Routing — Routes are/);
    expect(result.stdout).toContain("\nOther\n");

    const json = JSON.parse(docs(dir, [], { json: true }).stdout);
    expect(json.pages.find((page) => page.slug === "recipes-auth")).toMatchObject({
      path: "/docs/recipes/auth",
      url: "https://pracht.resynapse.dev/docs/recipes/auth",
      section: "Recipes",
    });
  });

  it("prints a page by slug, site path, file name, title, or unique word", () => {
    const dir = writeFixtureBundle();
    for (const topic of [
      ["routing"],
      ["/docs/routing"],
      ["routing.md"],
      ["Routing"],
      ["docs\\routing"],
    ]) {
      const result = docs(dir, topic);
      expect(result.exitCode, topic.join(" ")).toBe(0);
      expect(result.stdout, topic.join(" ")).toMatch(/^---\ntitle: "Routing"\n/);
    }
    expect(docs(dir, ["recipes/auth"]).stdout).toMatch(/^---\ntitle: "Authentication"/);
    expect(docs(dir, ["nextjs"]).stdout).toMatch(/^---\ntitle: "Migrating from Next\.js"/);
    expect(docs(dir, ["migrating", "from", "next.js"]).stdout).toMatch(/Migrating from Next/);
  });

  it("rewrites site links to sibling pages", () => {
    const page = docs(writeFixtureBundle(), ["routing"]).stdout;

    expect(page).toContain("[loaders](data-loading.md#loaders)");
    expect(page).toContain("url: https://pracht.resynapse.dev/docs/routing");
  });

  it("prints one section and reports the anchor it resolved to", () => {
    const dir = writeFixtureBundle();

    const section = docs(dir, ["routing#route-manifest"]);
    expect(section.stdout).toMatch(/^## Route Manifest\n\nDeclare/);
    expect(section.stdout).not.toContain("## `<Link>` props");

    const byHeading = JSON.parse(docs(dir, ["routing#Route Manifest"], { json: true }).stdout);
    expect(byHeading).toMatchObject({
      section: "route-manifest",
      url: "https://pracht.resynapse.dev/docs/routing#route-manifest",
    });

    // Code spans, and the tags inside them, are heading text — as on the site.
    expect(docs(dir, ["routing#link-props"]).stdout).toMatch(/^## `<Link>` props/);
    expect(docs(dir, ["routing#href-is-not-a-link-prop"]).exitCode).toBe(0);
    expect(docs(dir, ["routing#setup-1"]).stdout).toMatch(/^### Setup\n\nsecond setup/);
  });

  it("fails with suggestions only when a page name is close", () => {
    const dir = writeFixtureBundle();

    const typo = docs(dir, ["rooting"]);
    expect(typo.exitCode).toBe(1);
    expect(typo.stderr).toContain('Unknown docs topic "rooting". Did you mean routing');
    expect(typo.stderr).toContain("Run `pracht docs` to list every page");

    const ambiguous = docs(dir, ["i18n"]);
    expect(ambiguous.stderr).toContain("It matches several pages: recipes-i18n, reference-i18n");

    // Short words and stopwords name no page, and are close to everything.
    for (const topic of [["a"], ["the"], ["how", "do", "i"]]) {
      const result = docs(dir, topic);
      expect(result.exitCode, topic.join(" ")).toBe(1);
      expect(result.stderr, topic.join(" ")).not.toContain("Did you mean");
    }

    const section = docs(dir, ["routing#no-such-section"]);
    expect(section.exitCode).toBe(1);
    expect(section.stderr).toContain('No section "#no-such-section"');
    expect(section.stderr).toContain("route-manifest");
  });

  it("never reads outside the bundled pages", () => {
    const dir = writeFixtureBundle();
    for (const topic of ["../../package", "../package.json", "/etc/passwd", "..\\..\\package"]) {
      const result = docs(dir, [topic]);
      expect(result.exitCode, topic).toBe(1);
      expect(result.stdout, topic).toBe("");
      expect(result.stderr, topic).toContain("Unknown docs topic");
    }
  });

  it("searches on word starts, ignoring stopwords", () => {
    const dir = writeFixtureBundle();

    const natural = searchDocs("how do I add auth", { dir });
    expect(natural[0]).toMatchObject({ slug: "recipes-auth", anchor: "add-auth-middleware" });
    // "auth" starts "authentication" but sits inside "oauth".
    expect(natural.some((hit) => hit.anchor === "oauth-providers")).toBe(false);

    // "load" starts "loader" but sits inside "downloading".
    const load = searchDocs("load", { dir }).map((hit) => hit.anchor);
    expect(load).toContain("loaders");
    expect(load).not.toContain("downloading-files");

    // Prose and headings outrank a code block that repeats the word.
    expect(searchDocs("loader", { dir })[0]).toMatchObject({ anchor: "loaders" });
  });

  it("rejects empty or stopword-only searches and a topic with --search", () => {
    const dir = writeFixtureBundle();

    for (const search of ["", "  ", "how do I", "a"]) {
      const result = docs(dir, [], { search });
      expect(result.exitCode, JSON.stringify(search)).toBe(1);
      expect(result.stderr).toMatch(/Pass a search query|no searchable words/);
    }

    const both = docs(dir, ["routing"], { search: "loader" });
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("Pass a topic or --search, not both");

    const none = docs(dir, [], { search: "zzzqqqxx" });
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain('No docs match "zzzqqqxx"');

    const json = JSON.parse(docs(dir, [], { search: "loader", json: true }).stdout);
    expect(json).toMatchObject({ query: "loader" });
    expect(json.results.length).toBeGreaterThan(0);
  });

  it("reports an error as JSON with --json", () => {
    const result = docs(writeFixtureBundle(), ["nope-nope"], { json: true });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it("names the MCP tools, not CLI commands, in MCP errors", () => {
    const index = loadDocsIndex(writeFixtureBundle());
    const match = matchDocsTopic(index, "rooting", { surface: "mcp" });

    expect(match.ok).toBe(false);
    expect(match.message).toContain("list_docs");
    expect(match.message).not.toContain("pracht docs");
  });
});

describe("bundled docs runtime", () => {
  it("explains a missing bundle instead of throwing ENOENT", () => {
    const empty = createTempDir("pracht-docs-missing-");

    expect(docs(empty, []).stderr).toMatch(/bundled pracht docs are missing.*pnpm build/);
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

  it("does not treat headings inside code fences as sections", () => {
    const page = "---\ntitle: x\n---\n\n## Setup\n\n```md\n## Not a heading\n```\n\n## Next\n";
    const section = extractDocsSection(page, "setup");

    expect(section.ok && section.markdown).toContain("## Not a heading");
    expect(section.ok && section.markdown).not.toContain("## Next");
  });
});

// The one test that uses build output: the binary and the packaged bundle,
// run from a directory that is not a pracht app.
describe("pracht docs (installed bundle)", () => {
  it("lists and prints the bundled pages", () => {
    const cwd = createTempDir("pracht-docs-cli-");

    const list = runCliStatus(["docs"], { cwd });
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/^ {2}routing +Routing — /m);

    const page = runCliStatus(["docs", "routing#route-manifest"], { cwd });
    expect(page.status).toBe(0);
    expect(page.stdout).toMatch(/^## Route Manifest\n/);

    const unknown = runCliStatus(["docs", "../../package"], { cwd });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown docs topic");
  });
});
