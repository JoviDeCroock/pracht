// The docs site's MCP tools (src/capabilities/docs-*.ts) answer from an index
// over the `docs` content collection. These tests build that index from the
// authoring collection — the same documents the Worker's snapshot carries —
// and check that what the tools hand an agent points at real pages and real
// `#anchors`, and that no input reaches outside the collection.
import { beforeAll, describe, expect, it } from "vitest";

import { docsContent } from "../content";
import { NAV } from "../src/shells/docs";
import {
  buildDocsIndex,
  listDocs,
  markdownHeadings,
  MAX_READ_CHARS,
  queryTerms,
  readDoc,
  searchDocs,
  SITE_ORIGIN,
  type DocsIndex,
} from "../src/server/docs-index";

let index: DocsIndex;
let compiledIds: Map<string, string[]>;

beforeAll(async () => {
  const documents = await docsContent.all();
  index = await buildDocsIndex(docsContent);
  compiledIds = new Map(
    documents.map((document) => [
      document.path,
      [...document.compiled.html.matchAll(/<h[1-6] id="([^"]+)">/g)].map((match) => match[1]),
    ]),
  );
}, 60_000);

describe("docs MCP index", () => {
  it("pairs every Markdown heading with the id its rendered page carries", async () => {
    for (const document of await docsContent.all()) {
      const ids = compiledIds.get(document.path)!;
      expect(markdownHeadings(document.body).length, document.path).toBe(ids.length);
      const page = index.pages.find((candidate) => candidate.path === document.path)!;
      expect(page.sections.slice(1).map((section) => section.anchor)).toEqual(ids);
    }
  });

  it("lists every page once, grouped like the sidebar", () => {
    const groups = listDocs(index, NAV);
    const listed = groups.flatMap((group) => group.pages.map((page) => page.page));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(index.pages.map((page) => page.path).sort());
    // A page missing from the sidebar would land in "Other"; add it to NAV in src/shells/docs.tsx.
    expect(groups.map((group) => group.label)).not.toContain("Other");
  });
});

describe("docs_search", () => {
  it.each([
    ["createCapabilityHost", "/docs/standalone-capabilities"],
    ["remote mcp oauth", "/docs/capabilities"],
    ["islands hydration client strategy", "/docs/islands"],
    ["timeRevalidate webhook", "/docs/rendering"],
  ])("finds %j on %s", (query, page) => {
    const results = searchDocs(index, query, 8);
    expect(results.map((result) => result.page)).toContain(page);
  });

  it("returns anchors that exist on the rendered page", () => {
    for (const query of ["capability", "middleware auth", "deploy cloudflare", "search params"]) {
      for (const result of searchDocs(index, query, 20)) {
        expect(result.url).toBe(
          `${SITE_ORIGIN}${result.page}${result.section ? `#${result.section}` : ""}`,
        );
        if (result.section) expect(compiledIds.get(result.page)).toContain(result.section);
        expect(result.snippet.length).toBeLessThanOrEqual(222);
      }
    }
  });

  it("bounds results and tolerates hostile queries", () => {
    expect(searchDocs(index, "the", 100).length).toBeLessThanOrEqual(20);
    expect(searchDocs(index, "capability", 0).length).toBeGreaterThan(0);
    for (const query of ["!!!", "   ", ".*(", "[a-z]+$", "\u0000", "🙂"]) {
      expect(searchDocs(index, query, 5)).toEqual([]);
    }
    expect(() => searchDocs(index, "日本語 ü ß İ", 5)).not.toThrow();
    expect(queryTerms("a ".repeat(10_000) + "x".repeat(10_000)).length).toBeLessThanOrEqual(16);
    const pages = searchDocs(index, "pracht", 20).map((result) => result.page);
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

  it("resolves nested slugs and ids", () => {
    for (const page of ["recipes/auth", "recipes-auth", "/docs/recipes/auth"]) {
      expect(readDoc(index, page).page).toBe("/docs/recipes/auth");
    }
  });

  it("returns one section, subsections included, from an anchor or a URL fragment", () => {
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
  });

  it("explains an unknown section with the closest anchors", () => {
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

  it("cuts an oversized page at a section boundary", async () => {
    const section = (n: number) => `## Part ${n}\n\n${"word ".repeat(4_000)}\n\n`;
    const body = Array.from({ length: 6 }, (_, n) => section(n)).join("");
    const oversized = await buildDocsIndex({
      all: async () => [
        {
          id: "big",
          path: "/docs/big",
          frontmatter: { title: "Big" },
          body,
          compiled: {
            html: Array.from({ length: 6 }, (_, n) => `<h2 id="part-${n}">Part ${n}</h2>`).join(""),
          },
        },
      ],
    });
    const result = readDoc(oversized, "big");
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(MAX_READ_CHARS + 20);
    expect(result.markdown.trimEnd().endsWith("…")).toBe(true);
    expect(readDoc(oversized, "big", "part-5").markdown.startsWith("## Part 5")).toBe(true);
  });
});
