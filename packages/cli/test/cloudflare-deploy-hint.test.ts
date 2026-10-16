import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeCloudflareDeploy, splitCloudflareWorkerExports } from "../src/commands/build.ts";

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
