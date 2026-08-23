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

  it("creates custom-slug aliases only for locales that need fallback", async () => {
    const root = await fixture({
      "en/guide.md": "English",
      "fr/guide-fr.md": "Français",
    });
    const collection = defineCollection({
      name: "localized-slugs",
      root,
      sources: [
        { id: "guide", source: "en/guide.md" },
        { id: "guide", source: "fr/guide-fr.md" },
      ],
      locales: {
        default: "en",
        supported: ["en", "fr", "nl"],
        fallback: { nl: "fr" },
        routePrefix: "always",
      },
      route: ({ locale, relativePath }) => `/${locale}/${relativePath}`,
    });

    await expect(collection.getByRoute("/en/guide")).resolves.toMatchObject({ locale: "en" });
    await expect(collection.getByRoute("/fr/guide-fr")).resolves.toMatchObject({ locale: "fr" });
    await expect(collection.getByRoute("/fr/guide")).resolves.toBeUndefined();
    await expect(collection.getByRoute("/en/guide-fr")).resolves.toBeUndefined();
    await expect(collection.resolveByRoute("/nl/guide-fr")).resolves.toMatchObject({
      document: { locale: "fr" },
      fallback: true,
      requestedLocale: "nl",
    });
    await expect(collection.getByRoute("/nl/guide")).resolves.toBeUndefined();

    const snapshot = await collection.snapshot();
    expect(snapshot.routeAliases).toEqual([{ id: "guide", locale: "nl", path: "/nl/guide-fr" }]);
    const runtime = defineSnapshotCollection(snapshot);
    await expect(runtime.getByRoute("/fr/guide")).resolves.toBeUndefined();
    await expect(runtime.getByRoute("/en/guide-fr")).resolves.toBeUndefined();
    await expect(runtime.resolveByRoute("/nl/guide-fr")).resolves.toMatchObject({
      document: { locale: "fr" },
      fallback: true,
      requestedLocale: "nl",
    });
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
        default: "fr",
        supported: ["en", "fr"],
        routePrefix: "never",
      },
    });

    await expect(collection.getByRoute("/guide")).resolves.toMatchObject({
      body: "Français",
      locale: "fr",
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
    await expect(runtime.getByRoute("/guide")).resolves.toMatchObject({
      body: "Français",
      locale: "fr",
    });
    await expect(runtime.getByRoute("/guide", { locale: "fr" })).resolves.toMatchObject({
      body: "Français",
      locale: "fr",
    });
  });

  it("keeps the configured default for locale-neutral routes with one translation", async () => {
    const root = await fixture({ "fr/guide.md": "Français" });
    const collection = defineCollection({
      name: "locale-neutral-fallback",
      root,
      locales: {
        default: "en",
        supported: ["en", "fr"],
        fallback: { en: "fr" },
        routePrefix: "never",
      },
    });

    await expect(collection.resolveByRoute("/guide")).resolves.toMatchObject({
      document: { locale: "fr" },
      fallback: true,
      requestedLocale: "en",
    });
    await expect(collection.getByRoute("/guide", { fallback: false })).resolves.toBeUndefined();

    const snapshot = await collection.snapshot();
    expect(snapshot.routeAliases).toEqual([]);
    const runtime = defineSnapshotCollection(snapshot);
    await expect(runtime.resolveByRoute("/guide")).resolves.toMatchObject({
      document: { locale: "fr" },
      fallback: true,
      requestedLocale: "en",
    });
    await expect(runtime.getByRoute("/guide", { fallback: false })).resolves.toBeUndefined();
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

  it("rejects callback routes that shadow generated locale aliases", async () => {
    const root = await fixture({ "en/a.md": "A", "fr/b.md": "B" });
    const collision = defineCollection({
      name: "localized-callback-collision",
      root,
      locales: { default: "en", supported: ["en", "fr"] },
      route: ({ id, locale }) => {
        if (id === "b" && locale === "fr") return "/fr/a";
        return locale === "fr" ? `/fr/${id}` : `/${id}`;
      },
    });

    await expect(collision.all()).rejects.toThrow(/ambiguous generated route alias "\/fr\/a"/);
  });

  it("rejects same-id callback routes that shadow generated locale aliases", async () => {
    const root = await fixture({ "en/a.md": "English", "de/a.md": "German" });
    const collision = defineCollection({
      name: "localized-same-id-callback-collision",
      root,
      locales: { default: "en", supported: ["en", "fr", "de"] },
      route: ({ id, locale }) => (locale === "en" ? `/${id}` : `/fr/${id}`),
    });

    await expect(collision.all()).rejects.toThrow(/ambiguous generated route alias "\/fr\/a"/);
  });

  it("rejects same-id fallback aliases that collapse different locales", async () => {
    const root = await fixture({ "en/a.md": "English", "de/a.md": "German" });
    const collision = defineCollection({
      name: "localized-same-id-alias-collision",
      root,
      sources: [
        { id: "a", source: "en/a.md" },
        { id: "a", source: "de/a.md" },
      ],
      locales: {
        default: "en",
        supported: ["en", "de", "fr", "nl"],
        fallback: { fr: "en", nl: "de" },
        routePrefix: "always",
      },
      route: ({ locale }) => (locale === "en" || locale === "de" ? `/${locale}/a` : "/shared"),
    });

    await expect(collision.all()).rejects.toThrow(/ambiguous generated route alias "\/shared"/);
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

  it("follows symbolic files and directories that stay inside the collection root", async () => {
    const root = await fixture({
      ".shared/page.md": "Shared page",
      ".shared/section/nested.md": "Shared section",
      "guides/own.md": "Own",
      "page.md": "Page",
    });
    await symlink(join(root, ".shared/page.md"), join(root, "linked-page.md"));
    await symlink(join(root, ".shared/section"), join(root, "linked-section"), "dir");
    // Links onto already scanned content name the same document twice, and a
    // link back at an ancestor would recurse until the stack blows.
    await symlink(join(root, "page.md"), join(root, "duplicate.md"));
    await symlink(join(root, "guides"), join(root, "duplicate-guides"), "dir");
    await symlink(root, join(root, "guides/loop"), "dir");
    const collection = defineCollection({ name: "docs", root });

    const documents = await collection.all();

    expect(documents.map((document) => document.path)).toEqual([
      "/guides/own",
      "/linked-page",
      "/linked-section/nested",
      "/page",
    ]);
    expect((await collection.getByRoute("/linked-page"))?.body).toBe("Shared page");
    expect((await collection.getByRoute("/linked-section/nested"))?.body).toBe("Shared section");
  });

  it("skips scanned symbolic links whose target escapes the collection root", async () => {
    const root = await fixture({ "inside.md": "Inside" });
    const outside = await fixture({ "outside.md": "Outside", "section/deep.md": "Deep" });
    await symlink(join(outside, "outside.md"), join(root, "linked.md"));
    await symlink(join(outside, "section"), join(root, "linked-section"), "dir");
    await symlink(join(root, "missing.md"), join(root, "dangling.md"));
    const collection = defineCollection({ name: "docs", root });

    // Unlike an explicit registration, an incidental link found by a scan must
    // not fail the whole collection.
    await expect(collection.all()).resolves.toMatchObject([{ path: "/inside" }]);
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

  it("indexes every translation under a locale-neutral llms.txt section prefix", async () => {
    const root = await fixture({
      "en/guide.md": "---\ntitle: Guide\n---\nEnglish body",
      "fr/guide.md": "---\ntitle: Guide FR\n---\nCorps",
    });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en", "fr"] },
      artifacts: [
        rawContentArtifacts({ path: (document) => `${document.path}.md` }),
        // The natural section prefix. Written against the published route it
        // would only ever match the unprefixed default locale.
        llmsTxtArtifacts({ title: "Docs", sections: [{ heading: "Docs", match: "/docs" }] }),
      ],
    });

    const artifacts = await collection.emitArtifacts();
    const summary = String(artifacts.find((artifact) => artifact.path === "/llms.txt")?.source);

    // Paired with the raw artifacts: the two generators read one registry, so
    // disagreeing about which documents exist is the bug worth catching.
    expect(artifacts.map((artifact) => artifact.path)).toContain("/fr/docs/guide.md");
    expect(summary).toContain("[Guide](/docs/guide)");
    expect(summary).toContain("[Guide FR](/fr/docs/guide)");
  });

  it("keeps locale prefixes matchable when every locale is prefixed", async () => {
    const root = await fixture({ "en/guide.md": "---\ntitle: Guide\n---\nBody" });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      locales: { default: "en", supported: ["en"], routePrefix: "always" },
      artifacts: [
        llmsTxtArtifacts({
          title: "Docs",
          sections: [{ heading: "Docs", match: "/docs" }],
          fullPath: false,
        }),
      ],
    });

    expect(String((await collection.emitArtifacts())[0].source)).toContain(
      "[Guide](/en/docs/guide)",
    );
  });

  it("names the helper when artifact options are malformed", () => {
    expect(() => (rawContentArtifacts as (options: unknown) => unknown)({ base: "/raw" })).toThrow(
      /rawContentArtifacts\(\) requires a `path` function/,
    );
    expect(() =>
      (rawContentArtifacts as (options: unknown) => unknown)({
        path: () => "/x.md",
        representation: "full",
      }),
    ).toThrow(/`representation` must be "raw" or "body"/);
    expect(() => (llmsTxtArtifacts as (options: unknown) => unknown)({})).toThrow(
      /llmsTxtArtifacts\(\) requires a non-empty `title`/,
    );
  });

  it("names the collection and generator index when an artifact generator throws", async () => {
    const root = await fixture({ "guide.md": "Guide" });
    const collection = defineCollection({
      name: "docs",
      root,
      artifacts: [
        () => [{ path: "/ok.txt", source: "ok" }],
        () => {
          throw new Error("boom");
        },
      ],
    });

    await expect(collection.emitArtifacts()).rejects.toThrow(
      /Content collection "docs" failed to generate artifacts from `artifacts\[1\]`: boom/,
    );
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
      'text/plain; title="💩"',
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

  it("answers 404 for pathnames a dynamic route forwards but no document can carry", async () => {
    const root = await fixture({ "page.md": "Body" });
    const collection = defineCollection({ name: "docs", root, routeBase: "/docs" });
    const notFound = vi.fn((path: string) => new Response(path, { status: 404 }));
    const loader = contentLoader(collection, { notFound });

    for (const pathname of ["/docs/%2e%2e", "/docs/%00", "/docs/\\page", "/docs/%zz", "docs"]) {
      await expect(
        loader({ params: {}, pathname, request: new Request("https://example.com/docs") }),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(notFound).toHaveBeenCalledTimes(5);
    expect(notFound).toHaveBeenCalledWith("/docs/%2e%2e");
  });

  it("omits opted-out representations from the snapshot without changing the collection", async () => {
    const root = await fixture({ "page.md": "---\ntitle: Page\n---\nBody" });
    const collection = defineCollection({
      name: "docs",
      root,
      routeBase: "/docs",
      snapshot: { raw: false },
    });

    expect(collection.snapshotFields).toEqual({ body: true, raw: true });
    await expect(collection.getByRoute("/docs/page")).resolves.toMatchObject({
      body: "Body",
      raw: "---\ntitle: Page\n---\nBody",
    });

    const snapshot = await collection.snapshot();
    expect(snapshot.fields).toEqual({ body: true, raw: false });
    expect(Object.hasOwn(snapshot.documents[0], "raw")).toBe(false);

    const runtime = defineSnapshotCollection(snapshot);
    expect(runtime.snapshotFields).toEqual({ body: true, raw: false });
    const document = await runtime.getByRoute("/docs/page");
    expect(document?.body).toBe("Body");
    expect(document?.raw).toBeUndefined();
  });

  it("keeps every snapshot representation by default and validates the opt-out", async () => {
    const root = await fixture({ "page.md": "Body" });
    const snapshot = await defineCollection({ name: "docs", root }).snapshot();

    expect(snapshot.fields).toBeUndefined();
    expect(snapshot.documents[0]).toMatchObject({ body: "Body", raw: "Body" });
    expect(defineSnapshotCollection(snapshot).snapshotFields).toEqual({ body: true, raw: true });

    expect(() => defineCollection({ name: "docs", root, snapshot: null as never })).toThrow(
      /snapshot must be an object/,
    );
    expect(() =>
      defineCollection({ name: "docs", root, snapshot: { raw: "no" as never } }),
    ).toThrow(/snapshot\.raw must be a boolean/);
    expect(() =>
      defineCollection({ name: "docs", root, snapshot: { compiled: false } as never }),
    ).toThrow(/snapshot does not support "compiled"/);
  });
});
