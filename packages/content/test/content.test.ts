import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contentLoader,
  defineCollection,
  llmsTxtArtifacts,
  markdownRepresentation,
  parseFrontmatter,
  rawContentArtifacts,
} from "../src/index.ts";
import { defineSnapshotCollection } from "../src/runtime.ts";

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

  it("does not apply global fallback lists to the default locale", async () => {
    const root = await fixture({ "fr/guide.md": "Français" });

    for (const fallback of ["fr", ["fr"]] as const) {
      const collection = defineCollection({
        name: "french-only",
        root,
        sources: [{ id: "guide", source: "fr/guide.md", locale: "fr" }],
        locales: { default: "en", supported: ["en", "fr"], fallback },
      });

      await expect(collection.getById("guide")).resolves.toBeUndefined();
      await expect(collection.getById("guide", { locale: "fr" })).resolves.toMatchObject({
        locale: "fr",
      });

      const runtime = defineSnapshotCollection(await collection.snapshot());
      await expect(runtime.getById("guide")).resolves.toBeUndefined();
      await expect(runtime.getById("guide", { locale: "fr" })).resolves.toMatchObject({
        locale: "fr",
      });
    }
  });

  it("keeps locale-neutral routes valid for every translated document", async () => {
    const root = await fixture({
      "en/guide.md": "English",
      "fr/guide.md": "Français",
    });
    const collection = defineCollection({
      name: "locale-neutral",
      root,
      locales: {
        default: "en",
        supported: ["en", "fr"],
        routePrefix: "never",
      },
    });

    await expect(collection.getByRoute("/guide", { locale: "en" })).resolves.toMatchObject({
      body: "English",
      locale: "en",
    });
    await expect(collection.getByRoute("/guide", { locale: "fr" })).resolves.toMatchObject({
      body: "Français",
      locale: "fr",
    });

    const runtime = defineSnapshotCollection(await collection.snapshot());
    await expect(runtime.getByRoute("/guide", { locale: "fr" })).resolves.toMatchObject({
      body: "Français",
      locale: "fr",
    });
  });

  it("rejects unsupported locale fallback targets during collection definition", async () => {
    const root = await fixture({ "en/guide.md": "English" });

    for (const fallback of ["de", ["fr", "de"], { fr: "de" }] as const) {
      expect(() =>
        defineCollection({
          name: "localized",
          root,
          locales: { default: "en", supported: ["en", "fr"], fallback },
        }),
      ).toThrow(/fallback uses unsupported content locale "de"/);
    }
  });

  it("rejects unsupported locale fallback record keys during collection definition", async () => {
    const root = await fixture({ "en/guide.md": "English" });

    expect(() =>
      defineCollection({
        name: "localized",
        root,
        locales: { default: "en", supported: ["en", "fr"], fallback: { fre: "en" } },
      }),
    ).toThrow(/fallback uses unsupported content locale "fre"/);
  });

  it("ignores inherited properties in locale fallback records", async () => {
    const root = await fixture({ "en/guide.md": "English" });
    const collection = defineCollection({
      name: "localized",
      root,
      locales: { default: "en", supported: ["en", "toString"], fallback: {} },
    });

    await expect(collection.getById("guide", { locale: "toString" })).resolves.toBeUndefined();

    const runtime = defineSnapshotCollection(await collection.snapshot());
    await expect(runtime.getById("guide", { locale: "toString" })).resolves.toBeUndefined();
  });

  it("only infers source locales from directory segments", async () => {
    const root = await fixture({ "en.md": "A page named after a locale" });
    const collection = defineCollection({
      name: "localized",
      root,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en", "fr"] },
    });

    await expect(collection.getById("en")).resolves.toMatchObject({
      id: "en",
      locale: "en",
      path: "/docs/en",
    });
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

  it("rejects explicit routes that shadow generated locale aliases", async () => {
    const root = await fixture({ "a.md": "A", "b.md": "B" });
    const collision = defineCollection({
      name: "localized-collision",
      root,
      sources: [
        { id: "a", source: "a.md", locale: "en" },
        { id: "b", path: "/fr/a", source: "b.md", locale: "fr" },
      ],
      locales: { default: "en", supported: ["en", "fr"] },
    });

    await expect(collision.all()).rejects.toThrow(/ambiguous generated route alias "\/fr\/a"/);

    const localeCollision = defineCollection({
      name: "localized-same-id-collision",
      root,
      sources: [
        { id: "a", source: "a.md", locale: "en" },
        { id: "a", path: "/fr/a", source: "b.md", locale: "de" },
      ],
      locales: { default: "en", supported: ["en", "fr", "de"] },
    });

    await expect(localeCollision.all()).rejects.toThrow(
      /ambiguous generated route alias "\/fr\/a"/,
    );
  });

  it("rejects explicit sources whose symbolic links escape the collection root", async () => {
    const root = await fixture({ "inside.md": "Inside" });
    const outside = await fixture({ "outside.md": "Outside" });
    await symlink(join(outside, "outside.md"), join(root, "linked.md"));
    const collection = defineCollection({
      name: "linked",
      root,
      sources: [{ source: "linked.md" }],
    });

    await expect(collection.all()).rejects.toThrow(/after resolving symbolic links/);
  });

  it("matches Vite-canonicalized sources when the collection root is symbolic", async () => {
    const root = await fixture({ "page.md": "Same" });
    const parent = await fixture({});
    const linkedRoot = join(parent, "docs");
    await symlink(root, linkedRoot, "dir");
    const canonicalSource = await realpath(join(linkedRoot, "page.md"));
    let revision = 1;
    const collection = defineCollection({
      name: "linked-root",
      root: linkedRoot,
      compile: () => revision,
      module: ({ compiled }) => `export default ${compiled};`,
    });

    expect(collection.ownsSource(canonicalSource)).toBe(true);
    expect(await collection.getBySource(canonicalSource)).toMatchObject({
      source: join(linkedRoot, "page.md"),
    });
    expect(await collection.renderModule(canonicalSource, "Same")).toBe("export default 1;");

    revision = 2;
    collection.invalidate(canonicalSource);
    expect(await collection.renderModule(canonicalSource, "Same")).toBe("export default 2;");

    const linkedSource = join(linkedRoot, "page.md");
    await rm(linkedSource);
    expect(collection.ownsSource(linkedSource)).toBe(true);
    collection.invalidate(linkedSource);
    await expect(collection.all()).resolves.toEqual([]);
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

  it("caches the registry and resolves relative invalidation against the collection root", async () => {
    const root = await fixture({ "page.md": "Same" });
    let revision = 1;
    const route = vi.fn(() => "/page");
    const collection = defineCollection({
      name: "docs",
      root,
      sources: [{ source: "page.md" }],
      route,
      compile: () => revision,
    });

    expect((await collection.loadSource("page.md", "Same")).compiled).toBe(1);
    await collection.getByRoute("/page");
    expect(route).toHaveBeenCalledTimes(1);

    revision = 2;
    collection.invalidate("page.md");
    expect((await collection.loadSource("page.md", "Same")).compiled).toBe(2);
    expect(route).toHaveBeenCalledTimes(2);
  });

  it("rehydrates portable snapshots with locale fallback and no source filesystem", async () => {
    const root = await fixture({
      "en/guide.md": "English",
      "fr/guide.md": "Français",
      "en/default.md": "Default",
    });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en", "fr"] },
    });
    const runtime = defineSnapshotCollection(await collection.snapshot());

    expect((await runtime.getByRoute("/fr/docs/guide"))?.body).toBe("Français");
    expect((await runtime.resolveByRoute("/fr/docs/default"))?.fallback).toBe(true);
    expect((await runtime.getBySource("en/guide.md"))?.body).toBe("English");
    expect((await runtime.all())[0].source).toMatch(/^virtual:pracht\/content\/docs\//);
  });
});

describe("parseFrontmatter", () => {
  it("removes an empty frontmatter block from the document body", () => {
    expect(parseFrontmatter("---\n---\nBody")).toEqual({ body: "Body", frontmatter: {} });
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

  it("treats a root llms.txt section as a prefix for every content route", async () => {
    const root = await fixture({ "guide.md": "---\ntitle: Guide\n---\nBody" });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      artifacts: [
        llmsTxtArtifacts({
          title: "Docs",
          sections: [{ heading: "Everything", match: "/" }],
          fullPath: false,
        }),
      ],
    });

    expect(String((await collection.emitArtifacts())[0].source)).toContain("[Guide](/docs/guide)");
  });

  it("rejects encoded artifact paths that adapters would map to different files", async () => {
    const root = await fixture({ "guide.md": "Guide" });

    for (const path of [
      "/%66oo.txt",
      "/legal terms.txt",
      "/café.txt",
      "/con.txt",
      "/feed.",
      "/search:latest.json",
    ]) {
      const collection = defineCollection({
        name: "docs",
        root,
        artifacts: [() => ({ path, source: "content" })],
      });

      await expect(collection.emitArtifacts()).rejects.toThrow(
        /without percent encoding|portable filesystem-safe/,
      );
    }
  });

  it("rejects Netlify's reserved root control files", async () => {
    const root = await fixture({ "guide.md": "Guide" });

    for (const path of [
      "/_headers",
      "/_HEADERS",
      "/_headers/rules.txt",
      "/_HEADERS/rules.txt",
      "/_redirects",
      "/_REDIRECTS",
      "/_redirects/rules.txt",
      "/_REDIRECTS/rules.txt",
    ]) {
      const collection = defineCollection({
        name: "docs",
        root,
        artifacts: [() => ({ path, source: "content" })],
      });

      await expect(collection.emitArtifacts()).rejects.toThrow(
        /reserved root \/_(?:headers|redirects)/,
      );
    }
  });

  it("rejects artifact content types that cannot be emitted as portable headers", async () => {
    const root = await fixture({ "guide.md": "Guide" });

    for (const contentType of [
      "",
      "   ",
      "not a media type",
      "text/plain, text/html",
      "text/plain 💩",
      "text/plain\r\nx-injected: yes",
      "text/plain\0",
    ]) {
      const collection = defineCollection({
        name: "docs",
        root,
        artifacts: [() => ({ path: "/content.txt", source: "content", contentType })],
      });

      await expect(collection.emitArtifacts()).rejects.toThrow(
        /contentType must be a valid portable HTTP media type without control characters/,
      );
    }
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
      loader({
        params: {},
        pathname: "/docs/page",
        request: new Request("https://example.com/app/docs/page"),
      }),
    ).resolves.toEqual({ markdown: "Body", title: "Page" });
    await expect(
      loader({ params: {}, request: new Request("https://example.com/missing") }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
