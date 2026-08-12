import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBuildRouteOutput, writeBuildRouteManifests } from "../src/build-route-output.ts";

const tempRoots: string[] = [];

function createBuildRoot(): { clientDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pracht-route-output-"));
  const clientDir = join(root, "dist/client");
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(join(root, "dist/server"), { recursive: true });
  tempRoots.push(root);
  return { clientDir, root };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

describe("createBuildRouteOutput", () => {
  const pages = [
    { path: "/", html: "home", headers: { "cache-control": "public" } },
    { path: "/pricing", html: "pricing", markdown: true },
    { path: "/refresh", html: "refresh" },
  ];
  const isgManifest = {
    "/pricing": { revalidate: { kind: "time", seconds: 60 } },
    "/refresh": { revalidate: { kind: "webhook", token: "secret" } },
  };

  it("derives headers and Markdown metadata from prerendered pages", () => {
    const result = createBuildRouteOutput(pages, isgManifest, {
      cloudflareWorkersCacheEnabled: false,
    });

    expect(result.headersManifest).toEqual({
      "/": { "cache-control": "public" },
      "/pricing": {},
      "/refresh": {},
    });
    expect(result.markdownManifest).toEqual({ "/pricing": true });
    expect(result.staticPages.map((page) => page.path)).toEqual(["/", "/pricing", "/refresh"]);
  });

  it("suppresses only time-revalidated snapshots under Workers Caching", () => {
    const result = createBuildRouteOutput(pages, isgManifest, {
      cloudflareWorkersCacheEnabled: true,
    });

    expect(result.edgeCachedIsgPaths).toEqual(["/pricing"]);
    expect(result.staticPages.map((page) => page.path)).toEqual(["/", "/refresh"]);
  });
});

describe("writeBuildRouteManifests", () => {
  it("writes public route metadata but keeps non-Cloudflare ISG policy private", () => {
    const { clientDir, root } = createBuildRoot();

    writeBuildRouteManifests({
      buildTarget: "node",
      clientDir,
      headersManifest: { "/": { "x-frame-options": "DENY" } },
      isgManifest: { "/pricing": { revalidate: { kind: "time", seconds: 60 } } },
      log: () => undefined,
      markdownManifest: { "/": true },
      root,
    });

    expect(
      JSON.parse(readFileSync(join(root, "dist/server/headers-manifest.json"), "utf-8")),
    ).toEqual({ "/": { "x-frame-options": "DENY" } });
    expect(JSON.parse(readFileSync(join(clientDir, "_pracht/markdown.json"), "utf-8"))).toEqual({
      "/": true,
    });
    expect(existsSync(join(root, "dist/server/isg-manifest.json"))).toBe(true);
    expect(existsSync(join(clientDir, "_pracht/isg.json"))).toBe(false);
  });

  it("publishes ISG metadata only for the Cloudflare asset binding", () => {
    const { clientDir, root } = createBuildRoot();
    const isgManifest = { "/pricing": { revalidate: { kind: "time", seconds: 60 } } };

    writeBuildRouteManifests({
      buildTarget: "cloudflare",
      clientDir,
      headersManifest: {},
      isgManifest,
      log: () => undefined,
      markdownManifest: {},
      root,
    });

    expect(JSON.parse(readFileSync(join(clientDir, "_pracht/isg.json"), "utf-8"))).toEqual(
      isgManifest,
    );
    expect(JSON.parse(readFileSync(join(clientDir, "_pracht/markdown.json"), "utf-8"))).toEqual({});
    expect(existsSync(join(root, "dist/server/headers-manifest.json"))).toBe(false);
  });
});
