import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentLoader,
  defineCollection,
  llmsTxtArtifacts,
  markdownRepresentation,
  rawContentArtifacts,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pracht-content-"));
  temporaryDirectories.push(root);
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return root;
}

describe("defineCollection", () => {
  it("builds one route/source registry with raw, frontmatter, body, and compiled forms", async () => {
    const root = await fixture({
      "guide.md": "---\ntitle: Guide\ntags: [one, two]\n---\n# Hello\n",
      "nested/index.md": "# Nested\n",
      "ignored.txt": "not content",
    });
    const compile = vi.fn(({ body }: { body: string }) => body.toUpperCase());
    const collection = defineCollection({ name: "docs", root, routeBase: "/docs", compile });

    const documents = await collection.all();
    expect(documents.map(({ id, path, relativeSource }) => ({ id, path, relativeSource }))).toEqual(
      [
        { id: "guide", path: "/docs/guide", relativeSource: "guide.md" },
        { id: "nested", path: "/docs/nested", relativeSource: "nested/index.md" },
      ],
    );
    expect(documents[0]).toMatchObject({
      body: "# Hello\n",
      compiled: "# HELLO\n",
      frontmatter: { tags: ["one", "two"], title: "Guide" },
      raw: "---\ntitle: Guide\ntags: [one, two]\n---\n# Hello\n",
    });
    expect(await collection.getByRoute("/docs/guide")).toBe(documents[0]);
    expect(await collection.getById("guide")).toBe(documents[0]);
    expect(await collection.getBySource("guide.md")).toBe(documents[0]);
    expect(compile).toHaveBeenCalledTimes(2);

    await collection.all();
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("resolves locale fallbacks without hiding the actual source locale", async () => {
    const root = await fixture({
      "en/guide.md": "---\ntitle: English\n---\nEnglish",
      "fr/guide.md": "---\ntitle: Français\n---\nFrançais",
      "en/only-default.md": "Default only",
    });
    const collection = defineCollection({
      name: "localized",
      root,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en", "fr", "nl"] },
    });

    expect((await collection.getById("guide", { locale: "fr" }))?.path).toBe("/fr/docs/guide");
    expect(await collection.getById("only-default")).toMatchObject({ locale: "en" });
    const fallback = await collection.resolveById("only-default", { locale: "nl" });
    expect(fallback).toMatchObject({ fallback: true, requestedLocale: "nl" });
    expect(fallback?.document.locale).toBe("en");
    const routeFallback = await collection.resolveByRoute("/nl/docs/only-default");
    expect(routeFallback).toMatchObject({ fallback: true, requestedLocale: "nl" });
    expect(routeFallback?.document.path).toBe("/docs/only-default");
    expect(
      await collection.getById("only-default", { fallback: false, locale: "nl" }),
    ).toBeUndefined();
    await expect(collection.getById("guide", { locale: "de" })).rejects.toThrow(
      /unsupported content locale/,
    );

    const frenchOnly = defineCollection({
      name: "french-only",
      root,
      routeBase: "/docs",
      sources: [{ id: "guide", source: "fr/guide.md", locale: "fr" }],
      locales: { default: "en", supported: ["en", "fr"] },
    });
    expect(await frenchOnly.getById("guide")).toBeUndefined();
    expect((await frenchOnly.getByRoute("/fr/docs/guide"))?.locale).toBe("fr");
  });

  it("supports an explicit route registry and rejects ambiguous mappings", async () => {
    const root = await fixture({ "a.md": "A", "b.md": "B" });
    const collection = defineCollection({
      name: "explicit",
      root,
      sources: [
        { id: "a", path: "/articles/a", source: "a.md" },
        { id: "b", path: "/articles/b", source: "b.md" },
      ],
    });
    expect((await collection.getByRoute("/articles/b"))?.body).toBe("B");

    const collision = defineCollection({
      name: "collision",
      root,
      sources: [
        { path: "/same", source: "a.md" },
        { path: "/same", source: "b.md" },
      ],
    });
    await expect(collision.all()).rejects.toThrow(/maps both/);
    expect(() => defineCollection({ name: "unsafe", root, routeBase: "/%2e%2e/private" })).toThrow(
      /safe root-relative/,
    );
  });

  it("invalidates transformed source memoization deliberately", async () => {
    const root = await fixture({ "page.md": "First" });
    const compile = vi.fn(({ body }: { body: string }) => body.length);
    const collection = defineCollection({ name: "docs", root, compile });
    const source = join(root, "page.md");

    expect((await collection.loadSource(source, "First")).compiled).toBe(5);
    expect((await collection.loadSource(source, "First")).compiled).toBe(5);
    expect(compile).toHaveBeenCalledTimes(1);
    collection.invalidate(source);
    expect((await collection.loadSource(source, "Second")).compiled).toBe(6);
    expect(compile).toHaveBeenCalledTimes(2);
  });
});

describe("collection integration helpers", () => {
  it("emits raw sources and curated llms.txt artifacts from the same documents", async () => {
    const root = await fixture({
      "one.md": "---\ntitle: One\nlead: First page\n---\n# One body\n",
      "two.md": "---\ntitle: Two\n---\n# Two body\n",
    });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      artifacts: [
        rawContentArtifacts({ path: (document) => `${document.path}.md` }),
        llmsTxtArtifacts({
          title: "Example",
          description: "Example docs.",
          origin: "https://example.com",
          sections: [{ heading: "Docs", match: "/docs" }],
        }),
      ],
    });

    const artifacts = await collection.emitArtifacts();
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "/docs/one.md",
      "/docs/two.md",
      "/llms.txt",
      "/llms-full.txt",
    ]);
    expect(String(artifacts[2].source)).toContain(
      "- [One](https://example.com/docs/one): First page",
    );
    expect(String(artifacts[3].source)).toContain("# One body");
    expect(String(artifacts[3].source)).not.toContain("title: One");
  });

  it("adapts route lookup to loaders and markdown negotiation", async () => {
    const root = await fixture({ "page.md": "---\ntitle: Page\n---\nBody" });
    const collection = defineCollection({ name: "docs", root, routeBase: "/docs" });
    const loader = contentLoader(collection, {
      select: (document) => ({
        markdown: markdownRepresentation(document, "body"),
        title: document.frontmatter.title,
      }),
    });

    await expect(
      loader({ params: {}, request: new Request("https://example.com/docs/page") }),
    ).resolves.toEqual({ markdown: "Body", title: "Page" });
    await expect(
      loader({ params: {}, request: new Request("https://example.com/missing") }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
