import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PrachtAdapterBuildContext } from "@pracht/vite-plugin";

import {
  describeCloudflareDeploy,
  describeCloudflareWebhookScope,
  finalizeCloudflareBuild,
  splitCloudflareWorkerExports,
} from "../src/build.ts";

describe("describeCloudflareDeploy", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  function project(generated?: object, redirect = false): string {
    const root = mkdtempSync(join(tmpdir(), "pracht-cf-deploy-hint-"));
    roots.push(root);
    if (generated) {
      mkdirSync(join(root, "dist/server"), { recursive: true });
      writeFileSync(join(root, "dist/server/wrangler.json"), JSON.stringify(generated));
    }
    if (redirect) {
      mkdirSync(join(root, ".wrangler/deploy"), { recursive: true });
      writeFileSync(join(root, ".wrangler/deploy/config.json"), "{}");
    }
    return root;
  }

  it("points at the generated config when Wrangler is redirected to it", () => {
    expect(describeCloudflareDeploy(project({ definedEnvironments: [] }, true))).toContain(
      "uses the generated dist/server/wrangler.json",
    );
  });

  it("explains named environments the build did not select", () => {
    expect(
      describeCloudflareDeploy(project({ definedEnvironments: ["staging"] }, false)),
    ).toContain("CLOUDFLARE_ENV=<name>");
  });

  // A tool that owns the deploy (Void) removes the redirect on purpose.
  it("keeps the plain hint when the redirect was removed for another reason", () => {
    expect(describeCloudflareDeploy(project({ definedEnvironments: [] }, false))).toBe(
      "  Deploy with: wrangler deploy\n",
    );
    expect(describeCloudflareDeploy(project())).toBe("  Deploy with: wrangler deploy\n");
  });
});

// workerd fails to start when the deployed entry exports anything but
// handlers and entrypoint classes, e.g. `export const VERSION = "1"`.
describe("splitCloudflareWorkerExports", () => {
  it("keeps classes and handler objects and drops other values", () => {
    class Counter {}
    expect(
      splitCloudflareWorkerExports(
        Object.entries({
          default: { fetch() {} },
          Counter,
          handlers: { queue() {} },
          VERSION: "1",
          LIMIT: 3,
          nothing: null,
        }),
      ),
    ).toEqual({
      entrypointNames: ["Counter", "handlers"],
      droppedNames: ["VERSION", "LIMIT", "nothing"],
    });
  });
});

describe("describeCloudflareWebhookScope", () => {
  const webhook = { kind: "webhook" } as const;
  const hourly = { kind: "time", seconds: 3600 } as const;
  const manifest = {
    "/news": { revalidate: webhook },
    "/pricing": { revalidate: [hourly, webhook] },
    "/catalog": { revalidate: hourly },
  };

  it("warns about every webhook route on the per-data-center Cache API", () => {
    const warning = describeCloudflareWebhookScope(manifest, false);
    expect(warning).toContain("2 Cloudflare ISG page(s)");
    expect(warning).toContain("/news, /pricing");
    expect(warning).not.toContain("/catalog");
    expect(warning).toContain("cloudflareAdapter({ cache: true })");
  });

  it("leaves out webhook routes Workers Caching purges everywhere", () => {
    const warning = describeCloudflareWebhookScope(manifest, true);
    expect(warning).toContain("1 Cloudflare ISG page(s)");
    expect(warning).toContain("(/news)");
    expect(describeCloudflareWebhookScope({ "/pricing": manifest["/pricing"] }, true)).toBeNull();
  });

  it("stays quiet without webhook routes", () => {
    expect(
      describeCloudflareWebhookScope({ "/catalog": { revalidate: hourly } }, false),
    ).toBeNull();
  });

  it("is reported by finalizeBuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-cf-webhook-scope-"));
    try {
      const clientDir = join(root, "dist/client");
      mkdirSync(join(root, "dist/server"), { recursive: true });
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(join(root, "dist/server/worker.js"), "export default {};\n");
      const warnings: string[] = [];
      await finalizeCloudflareBuild({
        root,
        clientDir,
        publicDir: join(root, "public"),
        publicDirLabel: "public",
        base: "/",
        trailingSlash: "ignore",
        frameworkVersion: "0.0.0",
        serverEntry: {},
        pages: ["/news"],
        onDemandPages: [],
        isgManifest: { "/news": { revalidate: webhook } },
        headersManifest: {},
        markdownRoutes: [],
        markdownFiles: [],
        contentArtifacts: [],
        staticRoutes: [],
        log: () => {},
        warn: (message) => warnings.push(message),
      } as PrachtAdapterBuildContext);
      expect(warnings.join("")).toContain("1 Cloudflare ISG page(s)");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
