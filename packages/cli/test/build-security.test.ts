import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertNoContentArtifactOutputCollision,
  assertNoContentArtifactPathCollision,
  assertNoPrerenderedContentArtifactCollisions,
  assertNoPublicContentArtifactCollisions,
  assertNoPublicContentMetadataCollisions,
  assertNoRequestRouteContentArtifactCollisions,
  collectContentRoutePatterns,
  collectUnroutedContentDocuments,
  expandContentArtifactHeaders,
  formatUnroutedContentDocuments,
  readContentBuildManifest,
  reportBuildWarning,
  resolveGeneratedArtifactOutputPath,
  resolvePrerenderOutputPath,
  runBuild,
} from "../src/commands/build.ts";

const clientDir = resolve("/tmp/pracht-app/dist/client");

describe("readContentBuildManifest", () => {
  it("consumes one versioned artifact-and-route contribution", () => {
    const output = mkdtempSync(join(tmpdir(), "pracht-content-manifest-"));
    const manifestPath = resolve(output, "_pracht/content-manifest.json");
    try {
      mkdirSync(resolve(output, "_pracht"));
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          artifacts: { "/llms.txt": { "content-type": "text/markdown" } },
          routes: {
            policy: "warn",
            collections: { docs: [{ path: "/docs/guide", source: "guide.md" }] },
          },
        }),
      );

      expect(readContentBuildManifest(output)).toMatchObject({
        version: 1,
        artifacts: { "/llms.txt": { "content-type": "text/markdown" } },
        routes: { policy: "warn" },
      });
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      rmSync(output, { force: true, recursive: true });
    }
  });

  it("rejects a malformed optional route contribution", () => {
    const output = mkdtempSync(join(tmpdir(), "pracht-content-manifest-"));
    try {
      mkdirSync(resolve(output, "_pracht"));
      writeFileSync(
        resolve(output, "_pracht/content-manifest.json"),
        JSON.stringify({ version: 1, artifacts: {}, routes: null }),
      );
      expect(() => readContentBuildManifest(output)).toThrow(/content build manifest is invalid/);
    } finally {
      rmSync(output, { force: true, recursive: true });
    }
  });
});

describe("resolvePrerenderOutputPath", () => {
  it("resolves normal prerender routes inside dist/client", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/products/1")).toBe(
      resolve(clientDir, "products/1/index.html"),
    );
  });

  it("resolves the root route to dist/client/index.html", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/")).toBe(resolve(clientDir, "index.html"));
  });

  it("allows non-dot segments that merely start with dots", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/..not-a-dot-segment")).toBe(
      resolve(clientDir, "..not-a-dot-segment/index.html"),
    );
  });

  it("rejects traversal outside dist/client", () => {
    expect(() => resolvePrerenderOutputPath(clientDir, "/../../server/pwned")).toThrow(
      /outside dist\/client/i,
    );
  });

  it("rejects NUL bytes before calling filesystem APIs", () => {
    expect(() => resolvePrerenderOutputPath(clientDir, "/safe\0evil")).toThrow(/NUL byte/);
  });
});

describe("resolveGeneratedArtifactOutputPath", () => {
  it("resolves nested static artifacts inside dist/client", () => {
    expect(resolveGeneratedArtifactOutputPath(clientDir, "openapi.json")).toBe(
      "/tmp/pracht-app/dist/client/openapi.json",
    );
    expect(resolveGeneratedArtifactOutputPath(clientDir, "docs/index.html")).toBe(
      "/tmp/pracht-app/dist/client/docs/index.html",
    );
  });

  it("rejects absolute paths and traversal", () => {
    expect(() => resolveGeneratedArtifactOutputPath(clientDir, "/tmp/openapi.json")).toThrow(
      /unsafe output path/,
    );
    expect(() => resolveGeneratedArtifactOutputPath(clientDir, "../openapi.json")).toThrow(
      /outside dist\/client/,
    );
  });
});

describe("assertNoContentArtifactPathCollision", () => {
  it("rejects a collection llms.txt that the core generator would overwrite", () => {
    expect(() =>
      assertNoContentArtifactPathCollision(
        { "/llms.txt": { "content-type": "text/markdown" } },
        "/llms.txt",
        "the core generator",
      ),
    ).toThrow(/collides with the core generator/);

    expect(() =>
      assertNoContentArtifactPathCollision(
        { "/LLMS.TXT": { "content-type": "text/markdown" } },
        "/llms.txt",
        "the core generator",
      ),
    ).toThrow(/collides with the core generator/);
  });

  it("allows distinct generated paths", () => {
    expect(() =>
      assertNoContentArtifactPathCollision(
        { "/llms-full.txt": { "content-type": "text/markdown" } },
        "/llms.txt",
        "the core generator",
      ),
    ).not.toThrow();
  });
});

describe("assertNoContentArtifactOutputCollision", () => {
  it("rejects portable OpenAPI output collisions", () => {
    expect(() =>
      assertNoContentArtifactOutputCollision(
        { "/OpenAPI.json": { "content-type": "application/json" } },
        "openapi.json",
        "OpenAPI artifact",
      ),
    ).toThrow(/collides with OpenAPI artifact/);

    expect(() =>
      assertNoContentArtifactOutputCollision(
        { "/reference": { "content-type": "text/html" } },
        "reference/index.html",
        "OpenAPI artifact",
      ),
    ).toThrow(/collides with OpenAPI artifact/);
  });

  it("allows unrelated companion output paths", () => {
    expect(() =>
      assertNoContentArtifactOutputCollision(
        { "/search.json": { "content-type": "application/json" } },
        "openapi.json",
        "OpenAPI artifact",
      ),
    ).not.toThrow();
  });
});

describe("assertNoPublicContentArtifactCollisions", () => {
  it("rejects public files that occupy internal content build manifests", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pracht-content-public-"));
    try {
      mkdirSync(resolve(publicDir, "_pracht"));
      writeFileSync(resolve(publicDir, "_pracht/content-manifest.json"), "{}");

      expect(() => assertNoPublicContentMetadataCollisions(publicDir)).toThrow(
        /public\/_pracht\/content-manifest\.json.*internal content build manifests/,
      );
    } finally {
      rmSync(publicDir, { force: true, recursive: true });
    }
  });

  it("rejects file-directory collisions with internal content build manifests", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pracht-content-public-"));
    try {
      writeFileSync(resolve(publicDir, "_pracht"), "public blocker");

      expect(() => assertNoPublicContentMetadataCollisions(publicDir)).toThrow(
        /public\/_pracht.*internal content build manifests/,
      );
    } finally {
      rmSync(publicDir, { force: true, recursive: true });
    }
  });

  it("rejects public files that would overwrite generated content artifacts", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pracht-content-public-"));
    try {
      mkdirSync(resolve(publicDir, "feeds"));
      writeFileSync(resolve(publicDir, "feeds/search.json"), "public");

      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/feeds/search.json": { "content-type": "application/json" } },
          publicDir,
        ),
      ).toThrow(/collides with.*public\/feeds\/search\.json/);
    } finally {
      rmSync(publicDir, { force: true, recursive: true });
    }
  });

  it("rejects portable and file-directory collisions with public files", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pracht-content-public-"));
    try {
      mkdirSync(resolve(publicDir, "feeds"));
      writeFileSync(resolve(publicDir, "Feed.json"), "case collision");
      writeFileSync(resolve(publicDir, "feeds/blocker"), "ancestor collision");

      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/feed.json": { "content-type": "application/json" } },
          publicDir,
        ),
      ).toThrow(/collides with.*public\/Feed\.json/);
      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/feeds/blocker/items.json": { "content-type": "application/json" } },
          publicDir,
        ),
      ).toThrow(/collides with.*public\/feeds\/blocker/);
    } finally {
      rmSync(publicDir, { force: true, recursive: true });
    }
  });

  it("allows public files at unrelated paths", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pracht-content-public-"));
    try {
      writeFileSync(resolve(publicDir, "robots.txt"), "User-agent: *");

      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/feeds/search.json": { "content-type": "application/json" } },
          publicDir,
        ),
      ).not.toThrow();
    } finally {
      rmSync(publicDir, { force: true, recursive: true });
    }
  });

  it("follows public directory symlinks without treating the mount as a file", () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-content-public-symlink-"));
    const publicDir = resolve(root, "public");
    const sharedDir = resolve(root, "shared");
    try {
      mkdirSync(publicDir);
      mkdirSync(sharedDir);
      writeFileSync(resolve(sharedDir, "existing.txt"), "public");
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(sharedDir, resolve(publicDir, "shared"), symlinkType);
      symlinkSync(publicDir, resolve(sharedDir, "public-loop"), symlinkType);

      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/shared/generated.txt": { "content-type": "text/plain" } },
          publicDir,
        ),
      ).not.toThrow();
      expect(() =>
        assertNoPublicContentArtifactCollisions(
          { "/shared/existing.txt": { "content-type": "text/plain" } },
          publicDir,
        ),
      ).toThrow(/collides with.*public\/shared\/existing\.txt/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses Vite's configured publicDir during a build", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-content-custom-public-"));
    try {
      mkdirSync(resolve(root, "static"));
      writeFileSync(resolve(root, "static/content.txt"), "public");
      writeFileSync(
        resolve(root, "vite.config.mjs"),
        `const CLIENT = "\\0virtual:pracht/client";
const SERVER = "\\0virtual:pracht/server";
let isSsrBuild = false;

export default {
  publicDir: "static",
  plugins: [{
    name: "content-collision-fixture",
    configResolved(config) {
      isSsrBuild = Boolean(config.build.ssr);
    },
    resolveId(id) {
      if (id === "virtual:pracht/client") return CLIENT;
      if (id === "virtual:pracht/server") return SERVER;
    },
    load(id) {
      if (id === CLIENT) return "console.log('client')";
      if (id === SERVER) {
        return "export const resolvedApp = { routes: [] }; export async function prerenderApp() { return { pages: [], isgManifest: {} }; }";
      }
    },
    generateBundle() {
      if (isSsrBuild) return;
      this.emitFile({ type: "asset", fileName: "content.txt", source: "generated" });
      this.emitFile({
        type: "asset",
        fileName: "_pracht/content-manifest.json",
        source: JSON.stringify({
          version: 1,
          artifacts: { "/content.txt": { "content-type": "text/plain" } },
        }),
      });
    },
  }],
};
`,
      );

      await expect(runBuild(root, { analyzeJson: true })).rejects.toThrow(
        /collides with.*static\/content\.txt/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects reserved files from Vite's configured publicDir before reading them", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-content-reserved-public-"));
    try {
      mkdirSync(resolve(root, "static/_pracht"), { recursive: true });
      writeFileSync(resolve(root, "static/_pracht/content-manifest.json"), "not json");
      writeFileSync(
        resolve(root, "vite.config.mjs"),
        `const CLIENT = "\\0virtual:pracht/client";
const SERVER = "\\0virtual:pracht/server";

export default {
  publicDir: "static",
  plugins: [{
    name: "reserved-content-metadata-fixture",
    resolveId(id) {
      if (id === "virtual:pracht/client") return CLIENT;
      if (id === "virtual:pracht/server") return SERVER;
    },
    load(id) {
      if (id === CLIENT) return "console.log('client')";
      if (id === SERVER) {
        return "export const resolvedApp = { routes: [] }; export async function prerenderApp() { return { pages: [], isgManifest: {} }; }";
      }
    },
  }],
};
`,
      );

      await expect(runBuild(root, { analyzeJson: true })).rejects.toThrow(
        /static\/_pracht\/content-manifest\.json.*internal content build manifests/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("content route reconciliation warnings", () => {
  it("writes warnings to stderr when build analysis is JSON", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reportBuildWarning("Warning: 1 content document", true);

      expect(error).toHaveBeenCalledWith(expect.stringMatching(/Warning: 1 content document/));
      expect(log).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});

describe("assertNoPrerenderedContentArtifactCollisions", () => {
  it("rejects exact and ancestor collisions with prerendered page files", () => {
    expect(() =>
      assertNoPrerenderedContentArtifactCollisions(
        { "/guide/index.html": { "content-type": "application/json" } },
        clientDir,
        ["/guide"],
      ),
    ).toThrow(/collides with the prerendered output for route "\/guide"/);

    expect(() =>
      assertNoPrerenderedContentArtifactCollisions(
        { "/guide": { "content-type": "application/json" } },
        clientDir,
        ["/guide"],
      ),
    ).toThrow(/collides with the prerendered output for route "\/guide"/);
  });

  it("rejects case-folded collisions and allows unrelated artifact files", () => {
    expect(() =>
      assertNoPrerenderedContentArtifactCollisions(
        { "/GUIDE/INDEX.HTML": { "content-type": "text/html" } },
        clientDir,
        ["/guide"],
      ),
    ).toThrow(/collides with the prerendered output/);

    expect(() =>
      assertNoPrerenderedContentArtifactCollisions(
        { "/guide.md": { "content-type": "text/markdown" } },
        clientDir,
        ["/guide"],
      ),
    ).not.toThrow();
  });
});

describe("assertNoRequestRouteContentArtifactCollisions", () => {
  it("rejects exact request-time page and API route collisions", () => {
    expect(() =>
      assertNoRequestRouteContentArtifactCollisions(
        { "/dashboard": { "content-type": "text/html" } },
        [{ path: "/dashboard", render: "ssr" }],
        [],
        [],
      ),
    ).toThrow(/collides with ssr page route "\/dashboard"/);

    expect(() =>
      assertNoRequestRouteContentArtifactCollisions(
        { "/API/FEED": { "content-type": "application/json" } },
        [],
        [{ path: "/api/feed" }],
        [],
      ),
    ).toThrow(/collides with API route "\/api\/feed"/);
  });

  it("rejects clean-URL aliases and concrete ISG paths without snapshots", () => {
    expect(() =>
      assertNoRequestRouteContentArtifactCollisions(
        { "/account/index.html": { "content-type": "text/html" } },
        [{ path: "/account", render: "spa" }],
        [],
        [],
      ),
    ).toThrow(/collides with spa page route "\/account"/);

    expect(() =>
      assertNoRequestRouteContentArtifactCollisions(
        { "/posts/first": { "content-type": "text/html" } },
        [{ path: "/posts/:slug", render: "isg" }],
        [],
        ["/posts/first"],
      ),
    ).toThrow(/collides with generated page route "\/posts\/first"/);
  });

  it("allows artifacts beneath a dynamic route namespace without a concrete collision", () => {
    expect(() =>
      assertNoRequestRouteContentArtifactCollisions(
        { "/docs/getting-started.md": { "content-type": "text/markdown" } },
        [{ path: "/docs/*", render: "spa" }],
        [],
        [],
      ),
    ).not.toThrow();
  });
});

describe("expandContentArtifactHeaders", () => {
  it("adds clean URL aliases for generated index files without mutating the artifact registry", () => {
    const headers = {
      "/feed/index.html": { "content-type": "application/json" },
      "/index.html": { "content-type": "text/html" },
      "/llms.txt": { "content-type": "text/markdown" },
    };

    expect(expandContentArtifactHeaders(headers)).toEqual({
      ...headers,
      "/feed": headers["/feed/index.html"],
      "/": headers["/index.html"],
    });
    expect(Object.keys(headers)).toEqual(["/feed/index.html", "/index.html", "/llms.txt"]);
  });
});

describe("collectUnroutedContentDocuments", () => {
  const manifest = {
    policy: "warn" as const,
    collections: {
      docs: [
        { path: "/docs/guide", source: "guide.md" },
        { path: "/docs/orphan", source: "orphan.md" },
      ],
    },
  };

  it("reports documents whose generated route no app route serves", () => {
    // The registry discovers sources from disk while routes are registered by
    // hand, so an unregistered source publishes a dead URL into every artifact.
    expect(collectUnroutedContentDocuments(manifest, ["/"], ["/docs/guide"])).toEqual([
      { collection: "docs", path: "/docs/orphan", source: "orphan.md" },
    ]);
  });

  it("accepts documents served by a dynamic or catch-all route pattern", () => {
    // A data-backed collection renders through one parameterized route rather
    // than a manifest entry per document, and is not drift.
    expect(collectUnroutedContentDocuments(manifest, ["/docs/:slug"], [])).toEqual([]);
    expect(collectUnroutedContentDocuments(manifest, ["/docs/:rest*"], [])).toEqual([]);
    expect(collectUnroutedContentDocuments(manifest, ["/other/:slug"], [])).toEqual([
      { collection: "docs", path: "/docs/guide", source: "guide.md" },
      { collection: "docs", path: "/docs/orphan", source: "orphan.md" },
    ]);
  });

  it("classifies which route patterns can serve unprerendered paths", () => {
    const routes = [
      { path: "/about", render: "ssg" },
      { path: "/docs/:slug", render: "ssg" },
      { path: "/files/:rest*", render: "ssg" },
      { path: "/app/:view", render: "spa" },
    ];

    expect(collectContentRoutePatterns(routes, false)).toEqual([
      { path: "/about", servesUnprerenderedPaths: true },
      { path: "/docs/:slug", servesUnprerenderedPaths: true },
      { path: "/files/:rest*", servesUnprerenderedPaths: true },
      { path: "/app/:view", servesUnprerenderedPaths: true },
    ]);
    expect(collectContentRoutePatterns(routes, true)).toEqual([
      { path: "/about", servesUnprerenderedPaths: true },
      { path: "/docs/:slug", servesUnprerenderedPaths: false },
      { path: "/files/:rest*", servesUnprerenderedPaths: false },
      { path: "/app/:view", servesUnprerenderedPaths: false },
    ]);
    expect(collectContentRoutePatterns(routes, true, true).at(-1)).toEqual({
      path: "/app/:view",
      servesUnprerenderedPaths: true,
    });
  });

  it("trusts only concrete dynamic output without a static SPA fallback", () => {
    const routes = [
      { path: "/docs/:slug", render: "ssg" },
      { path: "/app/:view", render: "spa" },
    ];

    expect(
      collectUnroutedContentDocuments(manifest, collectContentRoutePatterns(routes, true), [
        "/docs/guide",
      ]),
    ).toEqual([{ collection: "docs", path: "/docs/orphan", source: "orphan.md" }]);
  });

  it("lets a static SPA fallback serve a matching dynamic route", () => {
    const routes = [{ path: "/docs/:slug", render: "spa" }];

    expect(
      collectUnroutedContentDocuments(
        manifest,
        collectContentRoutePatterns(routes, true, true),
        [],
      ),
    ).toEqual([]);
  });

  it("does not let a later SPA fallback bypass an earlier dynamic SSG route", () => {
    const routes = [
      { path: "/docs/:slug", render: "ssg" },
      { path: "/docs/:rest*", render: "spa" },
    ];

    expect(
      collectUnroutedContentDocuments(manifest, collectContentRoutePatterns(routes, true, true), [
        "/docs/guide",
      ]),
    ).toEqual([{ collection: "docs", path: "/docs/orphan", source: "orphan.md" }]);
  });

  it("does not let a shorter static route absorb a deeper document path", () => {
    expect(collectUnroutedContentDocuments(manifest, ["/docs"], [])).toHaveLength(2);
  });

  it("names the route, collection, and source file it found", () => {
    const report = formatUnroutedContentDocuments(
      collectUnroutedContentDocuments(manifest, ["/"], ["/docs/guide"]),
    );

    expect(report).toContain("1 content document generates a route no app route serves:");
    expect(report).toContain('/docs/orphan (collection "docs", orphan.md)');
  });
});
