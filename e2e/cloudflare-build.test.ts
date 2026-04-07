import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { parse as parseJsonc } from "jsonc-parser";

test("previte build emits a deployable Cloudflare Worker setup", async () => {
  test.setTimeout(120_000);

  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const exampleDir = resolve(repoRoot, "examples/cloudflare");
  const distDir = resolve(exampleDir, "dist");
  const wranglerPath = resolve(exampleDir, "wrangler.jsonc");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");

  rmSync(distDir, { force: true, recursive: true });

  execFileSync(process.execPath, ["../../packages/cli/bin/previte.js", "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: "pipe",
  });

  // wrangler.jsonc is user-owned (checked into the project), not generated
  expect(existsSync(wranglerPath)).toBe(true);
  expect(existsSync(serverEntryPath)).toBe(true);

  const wranglerConfig = parseJsonc(readFileSync(wranglerPath, "utf-8"));
  expect(wranglerConfig).toMatchObject({
    main: "dist/server/server.js",
    assets: {
      directory: "dist/client",
      binding: "ASSETS",
      run_worker_first: true,
    },
  });

  const workerSource = readFileSync(serverEntryPath, "utf-8");
  expect(workerSource).toContain("cloudflareAssetsBinding");
  expect(workerSource).toContain('buildTarget = "cloudflare"');
  expect(workerSource).toContain("server_default as default");
});
