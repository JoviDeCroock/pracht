import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { timeRevalidate } from "@pracht/core";
import { afterEach, describe, expect, it } from "vitest";

import { writeVercelBuildOutput } from "../src/build-shared.ts";

describe("writeVercelBuildOutput", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function createBuildRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pracht-vercel-build-output-"));
    roots.push(root);
    mkdirSync(join(root, "dist/client"), { recursive: true });
    mkdirSync(join(root, "dist/server"), { recursive: true });
    writeFileSync(join(root, "dist/server/server.js"), "export default {}\n", "utf-8");
    return root;
  }

  it("emits ISG routes as Node serverless functions", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      root,
      staticRoutes: ["/"],
    });

    const functionDir = join(root, ".vercel/output/functions/pricing.func");
    // Vercel fails the deployment when a `.prerender-config.json` sits next to
    // an edge function, so this one has to be a serverless function.
    expect(JSON.parse(readFileSync(join(functionDir, ".vc-config.json"), "utf-8"))).toEqual({
      handler: "_pracht-node-entry.cjs",
      launcherType: "Nodejs",
      runtime: expect.stringMatching(/^nodejs\d+\.x$/),
      shouldAddHelpers: false,
    });
    expect(readFileSync(join(functionDir, "_pracht-node-entry.cjs"), "utf-8")).toContain(
      'await import("./server.js")).nodeListener',
    );
    // Node types a module by its real path, so the bundle has to live inside
    // the function directory next to a `package.json` marking it as ESM.
    expect(lstatSync(join(functionDir, "server.js")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(functionDir, "package.json"), "utf-8"))).toEqual({
      type: "module",
    });
    expect(existsSync(join(root, ".vercel/output/functions/pricing.prerender-config.json"))).toBe(
      true,
    );
    // The main handler stays on the edge.
    expect(
      JSON.parse(
        readFileSync(join(root, ".vercel/output/functions/render.func/.vc-config.json"), "utf-8"),
      ),
    ).toMatchObject({ runtime: "edge" });
  });

  it("normalizes a scalar region for ISG serverless functions", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      regions: "iad1",
      root,
      staticRoutes: [],
    });

    const functionConfig = JSON.parse(
      readFileSync(join(root, ".vercel/output/functions/pricing.func/.vc-config.json"), "utf-8"),
    );
    expect(functionConfig.regions).toEqual(["iad1"]);
  });

  it("keeps the all sentinel on edge and uses the project default for ISG", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      regions: "all",
      root,
      staticRoutes: [],
    });

    const functionsDir = join(root, ".vercel/output/functions");
    const edgeConfig = JSON.parse(
      readFileSync(join(functionsDir, "render.func/.vc-config.json"), "utf-8"),
    );
    const nodeConfig = JSON.parse(
      readFileSync(join(functionsDir, "pricing.func/.vc-config.json"), "utf-8"),
    );
    expect(edgeConfig.regions).toBe("all");
    expect(nodeConfig).not.toHaveProperty("regions");
  });

  it("shares one serverless bundle across ISG routes", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: {
        "/pricing": { revalidate: timeRevalidate(60) },
        "/products/1": { revalidate: timeRevalidate(60) },
      },
      root,
      staticRoutes: [],
    });

    const functionsDir = join(root, ".vercel/output/functions");
    expect(lstatSync(join(functionsDir, "products/1.func")).isSymbolicLink()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(functionsDir, "products/1.func/.vc-config.json"), "utf-8")),
    ).toMatchObject({ launcherType: "Nodejs" });
    expect(existsSync(join(functionsDir, "products/1.prerender-config.json"))).toBe(true);
  });

  it("rejects an ISG route that collides with the default edge function", () => {
    const root = createBuildRoot();

    expect(() =>
      writeVercelBuildOutput({
        isgManifest: {
          "/render": { revalidate: timeRevalidate(60) },
        },
        root,
        staticRoutes: [],
      }),
    ).toThrow(
      'Cannot emit Vercel ISG route "/render" because its prerender function "render.func" collides with the main edge function "render.func".',
    );
    expect(existsSync(join(root, ".vercel/output"))).toBe(false);
  });

  it("rejects an ISG route that collides with a custom edge function name", () => {
    const root = createBuildRoot();

    expect(() =>
      writeVercelBuildOutput({
        functionName: "app",
        isgManifest: {
          "/app": { revalidate: timeRevalidate(60) },
        },
        root,
        staticRoutes: [],
      }),
    ).toThrow(/ISG route "\/app".*"app\.func".*main edge function "app\.func"/);
  });
});
