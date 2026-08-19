import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoContentArtifactOutputCollision,
  assertNoContentArtifactPathCollision,
  assertNoPrerenderedContentArtifactCollisions,
  assertNoPublicContentArtifactCollisions,
  resolveGeneratedArtifactOutputPath,
  resolvePrerenderOutputPath,
} from "../src/commands/build.ts";

const clientDir = resolve("/tmp/pracht-app/dist/client");

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
