import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
