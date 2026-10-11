// The docs site's MCP tools (src/capabilities/docs-*.ts) answer from an index
// that vite-plugin-docs-index.ts builds from the `docs` content collection and
// serves as `virtual:docs-mcp-index`. These tests load that exact module —
// produced by the plugin's own resolveId/load hooks and imported like the
// Worker imports it — so dropping a field from the artifact fails here rather
// than in the post-deploy check. They also check that what the tools hand an
// agent points at real pages and real `#anchors`, and that no input reaches
// outside the collection.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { docsContent } from "../content";
import { buildDocsIndexData, markdownHeadings } from "../docs-index-build";
import {
  hydrateDocsIndex,
  listDocs,
  MAX_READ_CHARS,
  NO_SEARCHABLE_WORDS,
  queryTerms,
  readDoc,
  searchDocs,
  SITE_ORIGIN,
  type DocsIndex,
} from "../src/server/docs-index";
import { stem, textStems } from "../src/server/docs-text";
import { NAV } from "../src/shells/docs";
import { docsIndex as docsIndexPlugin, DOCS_INDEX_MODULE } from "../vite-plugin-docs-index";

let index: DocsIndex;
let compiledIds: Map<string, string[]>;
let directory: string;

/** Run the plugin's hooks the way Vite does, as a given environment consumer. */
async function loadVirtualModule(consumer: "server" | "client"): Promise<string> {
  const plugin = docsIndexPlugin({ collection: docsContent });
  const resolveId = plugin.resolveId as (id: string) => string | null;
  const load = plugin.load as (this: unknown, id: string) => Promise<string>;
  return load.call({ environment: { config: { consumer } } }, resolveId(DOCS_INDEX_MODULE)!);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "docs-mcp-index-"));
  const file = join(directory, "index.mjs");
  await writeFile(file, await loadVirtualModule("server"));
  const { default: data } = await import(/* @vite-ignore */ pathToFileURL(file).href);
  index = hydrateDocsIndex(data);
  compiledIds = new Map(
    (await docsContent.all()).map((document) => [
      document.path,
      [...document.compiled.html.matchAll(/<h[1-6] id="([^"]+)">/g)].map((match) => match[1]),
    ]),
  );
}, 60_000);

afterAll(() => rm(directory, { recursive: true, force: true }));

describe("docs MCP index", () => {
  it("anchors every section to an id the rendered page carries", () => {
    for (const page of index.pages) {
      expect(
        page.sections.slice(1).map((section) => section.anchor),
        page.path,
      ).toEqual(compiledIds.get(page.path));
    }
  });

  it("covers every collection page", async () => {
    expect(index.pages.map((page) => page.path).sort()).toEqual(
      (await docsContent.all()).map((document) => document.path).sort(),
    );
  });

  it("fails the build when headings and compiled ids disagree", () => {
    expect(() =>
      buildDocsIndexData([
        {
          id: "x",
          path: "/docs/x",
          frontmatter: {},
          body: "## A\n\n## B\n",
          compiled: { html: '<h2 id="a">A</h2>' },
        },
      ]),
    ).toThrow("2 Markdown headings but 1 heading ids");
    expect(markdownHeadings("```md\n## not a heading\n```\n## Real\n")).toHaveLength(1);
  });

  it("is server-only", async () => {
    await expect(loadVirtualModule("client")).rejects.toThrow("server-only");
  });

  it("lists every page once, grouped like the sidebar", () => {
    const groups = listDocs(index, NAV);
    const listed = groups.flatMap((group) => group.pages.map((page) => page.page));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(index.pages.map((page) => page.path).sort());
    // A page missing from the sidebar would land in "Other"; add it to NAV in src/shells/docs.tsx.
    expect(groups.map((group) => group.label)).not.toContain("Other");
    expect(groups[0].pages[0]).toMatchObject({
      page: "/docs/getting-started",
      title: "Getting Started",
    });
    expect(groups[0].pages[0].lead.length).toBeGreaterThan(0);
  });
});

describe("docs_search", () => {
  const top = (query: string, count: number) =>
    searchDocs(index, query, count).results.map(
      (result) => `${result.page}${result.section ? `#${result.section}` : ""}`,
    );

  it.each([
    ["createCapabilityHost", "/docs/standalone-capabilities", 3],
    ["remote mcp oauth", "/docs/agent-trust#oauth-on-the-remote-mcp-endpoint", 1],
    ["islands hydration client strategy", "/docs/islands#loading-strategies", 5],
    ["timeRevalidate webhook", "/docs/rendering#isg--incremental-static-generation", 1],
    ["add authentication", "/docs/recipes/auth", 2],
    ["how to set page title", "/docs/data-loading#head-metadata", 3],
    ["loader", "/docs/data-loading#loaders", 3],
    ["what is pracht", "/docs/why-pracht", 3],
  ] as const)("ranks %j with %s in the top %i", (query, expected, count) => {
    const hits = top(query, count);
    expect(
      hits.some((hit) => hit === expected || hit.startsWith(`${expected}#`)),
      hits.join(", "),
    ).toBe(true);
  });

  it("matches whole words and their inflections, not substrings", () => {
    expect(stem("capabilities")).toBe(stem("capability"));
    expect(stem("routing")).toBe(stem("routes"));
    expect(stem("pages")).toBe(stem("page"));
    expect(stem("caches")).toBe(stem("cache"));
    expect(stem("additional")).not.toBe(stem("add"));
    // Sections that say "additional" but never "add" are not "add" hits.
    const add = new Set(index.postings.get("add")?.filter((_, at) => at % 2 === 0));
    const onlyAdditional = index.postings
      .get(stem("additional"))!
      .filter((_, at) => at % 2 === 0)
      .filter((section) => {
        const { page, ownStart, ownEnd } = index.sections[section];
        return ![...textStems(page.body.slice(ownStart, ownEnd))].some((w) => w.stem === "add");
      });
    expect(onlyAdditional.length).toBeGreaterThan(0);
    for (const section of onlyAdditional) expect(add.has(section)).toBe(false);
    // camelCase identifiers are found whole and by their parts.
    expect([...textStems("defineCapability")].map((word) => word.stem)).toEqual([
      "definecapabiliti",
      "defin",
      "capabiliti",
    ]);
  });

  it("explains a query with nothing searchable", () => {
    for (const query of ["how is the", "a b c", "!!!", "   ", ".*(", "[a-z]+$", "\u0000", "🙂"]) {
      expect(searchDocs(index, query, 5)).toEqual({ results: [], message: NO_SEARCHABLE_WORDS });
    }
    expect(searchDocs(index, "zzzqqqxxx", 5)).toEqual({
      results: [],
      message: "No docs section matches the query.",
    });
  });

  it("returns anchors that exist on the rendered page", () => {
    for (const query of ["capability", "middleware auth", "deploy cloudflare", "search params"]) {
      for (const result of searchDocs(index, query, 20).results) {
        expect(result.url).toBe(
          `${SITE_ORIGIN}${result.page}${result.section ? `#${result.section}` : ""}`,
        );
        if (result.section) expect(compiledIds.get(result.page)).toContain(result.section);
        expect(result.snippet.length).toBeLessThanOrEqual(222);
      }
    }
  });

  it("feeds every hit, introductions included, straight into docs_read", () => {
    const hits = searchDocs(index, "what is pracht", 20).results;
    expect(hits.some((hit) => hit.section === "")).toBe(true);
    for (const hit of hits) {
      expect(readDoc(index, hit.page, hit.section)).toMatchObject({ found: true, page: hit.page });
    }
  });

  it("bounds results and tolerates hostile queries", () => {
    expect(searchDocs(index, "page", 100).results.length).toBeLessThanOrEqual(20);
    expect(searchDocs(index, "capability", 0).results.length).toBeGreaterThan(0);
    expect(() => searchDocs(index, "日本語 ü ß İ constructor __proto__", 5)).not.toThrow();
    expect(queryTerms(`${"word ".repeat(10_000)}${"x".repeat(10_000)}`).length).toBeLessThanOrEqual(
      16,
    );
    const pages = searchDocs(index, "pracht", 20).results.map((result) => result.page);
    for (const page of new Set(pages)) {
      expect(pages.filter((candidate) => candidate === page).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("docs_read", () => {
  it.each([
    "capabilities",
    "/docs/capabilities",
    "docs/capabilities/",
    "/docs/capabilities.md",
    "https://pracht.resynapse.dev/docs/capabilities",
    "CAPABILITIES",
  ])("resolves %j", (page) => {
    const result = readDoc(index, page);
    expect(result).toMatchObject({ found: true, page: "/docs/capabilities", section: "" });
    expect(result.markdown.startsWith("# Capabilities\n")).toBe(true);
    expect(result.sections.length).toBeGreaterThan(5);
  });

  it("reads the whole page for an empty section", () => {
    expect(readDoc(index, "capabilities", "")).toEqual(readDoc(index, "capabilities"));
  });

  it("resolves nested slugs and ids", () => {
    for (const page of ["recipes/auth", "recipes-auth", "/docs/recipes/auth"]) {
      expect(readDoc(index, page).page).toBe("/docs/recipes/auth");
    }
  });

  it("returns one section, subsections included, without the page outline", () => {
    const direct = readDoc(
      index,
      "/docs/capabilities",
      "#remote-mcp-tools-for-agents-without-a-browser",
    );
    const viaUrl = readDoc(
      index,
      "https://pracht.resynapse.dev/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser",
    );
    expect(direct.found).toBe(true);
    expect(viaUrl.markdown).toBe(direct.markdown);
    expect(direct.markdown.startsWith("## Remote MCP: Tools for Agents Without a Browser")).toBe(
      true,
    );
    expect(direct.markdown).toContain("### Talking to It");
    expect(direct.markdown).not.toContain("## Private by Default");
    expect(direct.sections).toEqual([]);
  });

  it("explains an unknown section with the closest anchors and the outline", () => {
    const result = readDoc(index, "capabilities", "talking-to");
    expect(result.found).toBe(false);
    expect(result.suggestions).toContain("talking-to-it");
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.message).toContain("talking-to");
  });

  it("suggests close pages for a typo", () => {
    const result = readDoc(index, "capabilites");
    expect(result.found).toBe(false);
    expect(result.suggestions).toContain("/docs/capabilities");
    expect(result.markdown).toBe("");
    expect(readDoc(index, "/docs/../content.ts").suggestions[0]).toBe("/docs/content");
    // Unrelated short inputs get no guesses, only the pointer to docs_list.
    for (const page of ["/docs", "/", "__proto__"]) {
      expect(readDoc(index, page)).toMatchObject({ found: false, suggestions: [] });
    }
  });

  it.each([
    "../../wrangler.jsonc",
    "/docs/../content.ts",
    "/docs/%2e%2e/%2e%2e/package.json",
    "..%2f..%2fpackage.json",
    "/etc/passwd",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://evil.example/docs/capabilities",
    "//evil.example/docs/capabilities",
    "http://pracht.resynapse.dev@evil.example/docs/capabilities",
    "\u0000",
  ])("never resolves %j outside the collection", (page) => {
    const result = readDoc(index, page);
    expect(result.found).toBe(false);
    expect(result.markdown).toBe("");
  });

  it("cuts an oversized page at a section boundary", () => {
    const section = (n: number) => `## Part ${n}\n\n${"word ".repeat(4_000)}\n\n`;
    const oversized = hydrateDocsIndex(
      buildDocsIndexData([
        {
          id: "big",
          path: "/docs/big",
          frontmatter: { title: "Big" },
          body: Array.from({ length: 6 }, (_, n) => section(n)).join(""),
          compiled: {
            html: Array.from({ length: 6 }, (_, n) => `<h2 id="part-${n}">Part ${n}</h2>`).join(""),
          },
        },
      ]),
    );
    const result = readDoc(oversized, "big");
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(MAX_READ_CHARS + 20);
    expect(result.markdown.trimEnd().endsWith("…")).toBe(true);
    expect(readDoc(oversized, "big", "part-5").markdown.startsWith("## Part 5")).toBe(true);
  });
});
