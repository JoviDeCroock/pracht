import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertGeneratedArtifactPathsDoNotOverlap,
  excludePrerenderPagesShadowedByGeneratedArtifacts,
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

describe("excludePrerenderPagesShadowedByGeneratedArtifacts", () => {
  it("keeps generated files from colliding with same-path or descendant prerender directories", () => {
    const pages = [
      { path: "/guide" },
      { path: "/guide.md" },
      { path: "/guide.md/child" },
      { path: "/other" },
    ];

    expect(
      excludePrerenderPagesShadowedByGeneratedArtifacts(pages, [
        { outputPath: "guide.md" },
        { outputPath: "llms.txt" },
      ]),
    ).toEqual([{ path: "/guide" }, { path: "/other" }]);
  });
});

describe("assertGeneratedArtifactPathsDoNotOverlap", () => {
  it("accepts independent generated files", () => {
    expect(() =>
      assertGeneratedArtifactPathsDoNotOverlap(clientDir, [
        { generator: "llms.txt", outputPath: "llms.txt" },
        { generator: "OpenAPI", outputPath: "openapi.json" },
        { generator: "OpenAPI", outputPath: "docs/index.html" },
      ]),
    ).not.toThrow();
  });

  it("rejects exact and file-directory overlaps across generators", () => {
    expect(() =>
      assertGeneratedArtifactPathsDoNotOverlap(clientDir, [
        { generator: "llms.txt", outputPath: "llms.txt" },
        { generator: "OpenAPI", outputPath: "llms.txt/openapi.json" },
      ]),
    ).toThrow('OpenAPI artifact "llms.txt/openapi.json" overlaps llms.txt artifact "llms.txt"');

    expect(() =>
      assertGeneratedArtifactPathsDoNotOverlap(clientDir, [
        { generator: "llms.txt", outputPath: "docs/getting-started.md" },
        { generator: "OpenAPI", outputPath: "docs/getting-started.md" },
      ]),
    ).toThrow(/overlaps/);
  });
});
