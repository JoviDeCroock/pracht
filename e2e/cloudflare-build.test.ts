import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { parse as parseJsonc } from "jsonc-parser";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const exampleDir = resolve(repoRoot, "examples/cloudflare");
const distDir = resolve(exampleDir, "dist");

function buildCloudflareExample() {
  rmSync(distDir, { force: true, recursive: true });
  execFileSync(process.execPath, ["../../packages/cli/bin/pracht.js", "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: "pipe",
  });
}

test("pracht build emits a deployable Cloudflare Worker setup", async () => {
  test.setTimeout(120_000);

  const wranglerPath = resolve(exampleDir, "wrangler.jsonc");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");

  buildCloudflareExample();

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
  expect(workerSource).toContain("_pracht/headers.json");
  expect(workerSource).toContain("server_default as default");

  // Cloudflare primitives configured via `workerExportsFrom` must be re-exported
  expect(workerSource).toContain("Counter");
});

test("prerendered SSG pages include client JS and working framework context", async () => {
  test.setTimeout(120_000);

  if (!existsSync(distDir)) {
    buildCloudflareExample();
  }

  // The home route is render: "ssg" — it should be prerendered as a static HTML file
  const htmlPath = resolve(distDir, "client/index.html");
  const headersPath = resolve(distDir, "client/_pracht/headers.json");
  expect(existsSync(htmlPath)).toBe(true);
  expect(existsSync(headersPath)).toBe(true);
  const html = readFileSync(htmlPath, "utf-8");
  const headers = JSON.parse(readFileSync(headersPath, "utf-8"));
  expect(headers["/"]["x-pracht-shell"]).toBe("public");

  // Must include the client entry script for hydration
  expect(html).toMatch(/<script type="module" src="\/assets\/client-[^"]+\.js"><\/script>/);

  // Must include hydration state
  expect(html).toContain('<script id="pracht-state" type="application/json">');

  // Client assets must live directly in dist/client/assets/ (not nested deeper)
  const manifestPath = resolve(distDir, "client/.vite/manifest.json");
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const clientEntry = manifest["virtual:pracht/client"];
  expect(clientEntry).toBeDefined();
  expect(clientEntry.file).toMatch(/^assets\//);

  // The asset file referenced in the manifest must exist on disk
  const assetPath = resolve(distDir, "client", clientEntry.file);
  expect(existsSync(assetPath)).toBe(true);
});
