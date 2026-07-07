import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

test("pracht build emits a Deno server entry", async () => {
  test.setTimeout(120_000);

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const exampleDir = resolve(repoRoot, "examples/basic");
  const distDir = resolve(exampleDir, "dist");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");
  const staticIndexPath = resolve(exampleDir, "dist/client/index.html");
  const headersManifestPath = resolve(exampleDir, "dist/server/headers-manifest.json");

  rmSync(distDir, { force: true, recursive: true });

  const result = spawnSync(process.execPath, ["../../packages/cli/bin/pracht.js", "build"], {
    cwd: exampleDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      PRACHT_ADAPTER: "deno",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Deno example build failed");
  }

  expect(existsSync(serverEntryPath)).toBe(true);
  expect(existsSync(staticIndexPath)).toBe(true);
  expect(existsSync(headersManifestPath)).toBe(true);

  const output = `${result.stdout}${result.stderr}`;
  expect(output).toContain("Deno adapter currently serves prerendered ISG HTML");

  const serverSource = readFileSync(serverEntryPath, "utf-8");
  expect(serverSource).toContain('buildTarget = "deno"');
  expect(serverSource).toContain("createDenoRequestHandler");
  expect(serverSource).toContain('new URL("../client/", import.meta.url)');
  expect(serverSource).toContain("Deno.serve({ port }, handler)");
  expect(serverSource).toContain("Deno.readTextFile");
});
