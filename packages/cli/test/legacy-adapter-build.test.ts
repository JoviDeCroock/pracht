import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { finalizeCloudflareBuild } from "../../adapter-cloudflare/src/build.ts";
import { finalizeVercelBuild } from "../../adapter-vercel/src/build-output.ts";
import {
  finalizeLegacyAdapterBuild,
  type AdapterBuildContext,
} from "../src/legacy-adapter-build.ts";
import { assertPrachtServerEntry, assertServerEntryBuildTarget } from "../src/server-entry.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** A finished dist/ as `pracht build` leaves it before the adapter step. */
function createBuiltApp(): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-legacy-adapter-build-"));
  roots.push(root);
  mkdirSync(join(root, "dist/client/assets"), { recursive: true });
  mkdirSync(join(root, "dist/client/guide"), { recursive: true });
  mkdirSync(join(root, "dist/server"), { recursive: true });
  writeFileSync(join(root, "dist/client/index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "dist/client/guide/index.html"), "<h1>guide</h1>");
  writeFileSync(join(root, "dist/client/guide.md"), "# guide");
  writeFileSync(join(root, "dist/client/assets/app-abc.js"), "export {};");
  writeFileSync(join(root, "dist/server/server.js"), "export default {};\n");
  // A Worker entry re-exporting a value workerd rejects, so the rewrite runs.
  writeFileSync(
    join(root, "dist/server/worker.js"),
    'export default { fetch() {} };\nexport class Counter {}\nexport const buildTarget = "cloudflare";\n',
  );
  return root;
}

function context(root: string, logs: string[]): AdapterBuildContext {
  return {
    root,
    clientDir: join(root, "dist/client"),
    publicDir: join(root, "public"),
    publicDirLabel: "public",
    base: "/",
    trailingSlash: "never",
    frameworkVersion: "1.2.3",
    serverEntry: {
      nodeListener: () => {},
      vercelFunctionName: "render",
      vercelRegions: null,
      cloudflareWorkersCacheEnabled: true,
    },
    pages: ["/", "/guide", "/live"],
    onDemandPages: ["/live"],
    isgManifest: { "/live": { revalidate: { kind: "time", seconds: 60 } } },
    headersManifest: {
      "/guide": { "cache-control": "public, max-age=60" },
      "/assets/app-abc.js": { "x-asset": "1" },
    },
    markdownRoutes: ["/guide"],
    markdownFiles: [{ path: "/guide.md", outputPath: "guide.md" }],
    contentArtifacts: [],
    staticRoutes: [],
    log: (message) => logs.push(`log:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
  };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[relative(root, full)] = readFileSync(full, "utf-8");
    }
  };
  walk(root);
  return files;
}

/** The Vercel prerender bypass token is random per build unless pinned. */
function withRevalidateToken<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.PRACHT_REVALIDATE_TOKEN;
  process.env.PRACHT_REVALIDATE_TOKEN = "fixed-token";
  return run().finally(() => {
    if (previous === undefined) delete process.env.PRACHT_REVALIDATE_TOKEN;
    else process.env.PRACHT_REVALIDATE_TOKEN = previous;
  });
}

describe("finalizeLegacyAdapterBuild", () => {
  it("writes the same Vercel output as vercelAdapter().finalizeBuild", async () => {
    const legacyRoot = createBuiltApp();
    const adapterRoot = createBuiltApp();
    const legacyLogs: string[] = [];
    const adapterLogs: string[] = [];

    await withRevalidateToken(async () => {
      await finalizeLegacyAdapterBuild("vercel", context(legacyRoot, legacyLogs));
      finalizeVercelBuild(context(adapterRoot, adapterLogs), { functionName: "render" });
    });

    const legacy = snapshot(legacyRoot);
    const adapter = snapshot(adapterRoot);
    // The legacy copy stamps the CLI's own version; the adapter is handed it.
    const config = ".vercel/output/config.json";
    expect(JSON.parse(adapter[config]!).framework).toEqual({ version: "1.2.3" });
    delete legacy[config];
    delete adapter[config];
    expect(adapter).toEqual(legacy);
    expect(adapterLogs).toEqual(legacyLogs);
  });

  it("writes the same Cloudflare output as cloudflareAdapter().finalizeBuild", async () => {
    const legacyRoot = createBuiltApp();
    const adapterRoot = createBuiltApp();
    const legacyLogs: string[] = [];
    const adapterLogs: string[] = [];

    await finalizeLegacyAdapterBuild("cloudflare", context(legacyRoot, legacyLogs));
    await finalizeCloudflareBuild(context(adapterRoot, adapterLogs));

    const adapter = snapshot(adapterRoot);
    expect(adapter).toEqual(snapshot(legacyRoot));
    expect(adapter["dist/client/_pracht/isg.json"]).toContain('"/live"');
    expect(adapter["dist/server/worker.js"]).toBe(
      'export { Counter } from "./server.js";\nexport { default } from "./server.js";\n',
    );
    expect(adapterLogs).toEqual(legacyLogs);
    expect(adapterLogs.join("")).toContain("ISG via Workers Caching: 1 route(s)");
  });
});

describe("assertPrachtServerEntry", () => {
  it("names what a server bundle not built by pracht() is missing", () => {
    expect(() => assertPrachtServerEntry({ default: {} })).toThrow(
      "dist/server/server.js is missing resolvedApp and prerenderApp(), so it was not generated " +
        "by the pracht() Vite plugin. Build with `pracht build` (not `vite build`)",
    );
  });

  it("refuses a bundle whose build target is not the configured adapter's", () => {
    const entry = { resolvedApp: { routes: [] }, prerenderApp: () => [] } as never;
    expect(() => assertServerEntryBuildTarget(entry, "vercel")).toThrow(
      'dist/server/server.js reports build target null, but vite.config\'s pracht() adapter is "vercel"',
    );
    expect(() =>
      assertServerEntryBuildTarget(
        { ...(entry as object), buildTarget: "vercel" } as never,
        "vercel",
      ),
    ).not.toThrow();
    // A plugin release without adapter metadata leaves nothing to compare.
    expect(() => assertServerEntryBuildTarget(entry, undefined)).not.toThrow();
  });

  it("accepts a generated entry", () => {
    expect(() =>
      assertPrachtServerEntry({ resolvedApp: { routes: [] }, prerenderApp: () => [] }),
    ).not.toThrow();
  });
});
