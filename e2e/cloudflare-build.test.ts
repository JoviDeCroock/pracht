import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { parse as parseJsonc } from "jsonc-parser";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixtureDir = resolve(repoRoot, "examples/cloudflare");
const basicFixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

function createTempCloudflareExample(): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-cloudflare-build-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    return { exampleDir, tempDir };
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

function buildCloudflareExample(exampleDir: string): string {
  const result = spawnSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Cloudflare example build failed");
  }
  return `${result.stdout}${result.stderr}`;
}

test("pracht build emits a deployable Cloudflare Worker setup", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempCloudflareExample();
  try {
    const distDir = resolve(exampleDir, "dist");
    const wranglerPath = resolve(exampleDir, "wrangler.jsonc");
    const serverEntryPath = resolve(distDir, "server/server.js");
    const deployEntryPath = resolve(distDir, "server/worker.js");

    const output = buildCloudflareExample(exampleDir);

    // wrangler.jsonc is user-owned (checked into the project), not generated
    expect(existsSync(wranglerPath)).toBe(true);
    expect(existsSync(serverEntryPath)).toBe(true);
    expect(existsSync(deployEntryPath)).toBe(true);

    const wranglerConfig = parseJsonc(readFileSync(wranglerPath, "utf-8"));
    expect(wranglerConfig).toMatchObject({
      main: "dist/server/worker.js",
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
    expect(workerSource).toContain("_pracht/markdown.json");
    expect(workerSource).toContain("_pracht/isg.json");
    expect(workerSource).toContain("createCloudflareFetchHandler");
    expect(workerSource).toContain("server_default as default");
    expect(output).not.toContain("does not perform runtime revalidation");

    expect(
      JSON.parse(readFileSync(resolve(distDir, "server/markdown-manifest.json"), "utf-8")),
    ).toEqual({});
    expect(
      JSON.parse(readFileSync(resolve(distDir, "client/_pracht/markdown.json"), "utf-8")),
    ).toEqual({});

    // The example enables Workers Caching: the worker carries the ISG cache
    // wiring, the build reports it, and wrangler.jsonc turns the cache on.
    expect(workerSource).toContain("cloudflareWorkersCacheEnabled = true");
    expect(workerSource).toContain("cache: true");
    // Edge directives live in cloudflare-cdn-cache-control so
    // stale-while-revalidate is not disabled by the browser-facing
    // must-revalidate (RFC 9111 §4.2.4).
    expect(workerSource).toContain("cloudflare-cdn-cache-control");
    expect(workerSource).toContain("stale-while-revalidate");
    expect(output).toContain("ISG via Workers Caching");
    expect(wranglerConfig).toMatchObject({ cache: { enabled: true } });

    // Time-revalidated ISG pages must not be emitted as static snapshots —
    // they render on demand and live in the edge cache, otherwise they would
    // never revalidate.
    expect(existsSync(resolve(distDir, "client/pricing/index.html"))).toBe(false);
    expect(existsSync(resolve(distDir, "client/pricing.html"))).toBe(false);

    // Cloudflare primitives configured via `workerExportsFrom` must be re-exported
    expect(workerSource).toContain("Counter");
    // The Durable Object that owns the example's WebSocket connections. Its
    // handshake response has to survive the whole worker bundle — see
    // src/api/ws.ts.
    expect(workerSource).toContain("ChatRoom");
    expect(workerSource).toContain("acceptWebSocket");

    // The deploy entry re-exports only the default handler and entrypoint
    // classes: workerd rejects non-handler named exports (buildTarget,
    // manifests, ...) on the deployed entry module.
    const deploySource = readFileSync(deployEntryPath, "utf-8");
    expect(deploySource).toContain('export { ChatRoom, Counter } from "./server.js";');
    expect(deploySource).toContain('export { default } from "./server.js";');
    expect(deploySource).not.toContain("buildTarget");
    expect(deploySource).not.toContain("cssManifest");

    expect(existsSync(resolve(distDir, "client/_pracht/isg.json"))).toBe(true);

    // llms.txt lands in the static assets dir the worker serves via the ASSETS
    // binding; dynamic SSR routes without static paths are not listed.
    const llmsTxtPath = resolve(distDir, "client/llms.txt");
    expect(existsSync(llmsTxtPath)).toBe(true);
    const llmsTxt = readFileSync(llmsTxtPath, "utf-8");
    expect(llmsTxt.startsWith("# Pracht Cloudflare Example\n")).toBe(true);
    expect(llmsTxt).toContain("- [/pricing](/pricing)");
    expect(llmsTxt).not.toContain("/products/:id");

    // OpenAPI JSON and its optional UI are regular static assets, so workerd
    // serves them through the same ASSETS binding without runtime-only code.
    const openApiPath = resolve(distDir, "client/openapi.json");
    const openApiUiPath = resolve(distDir, "client/docs/index.html");
    expect(existsSync(openApiPath)).toBe(true);
    expect(existsSync(openApiUiPath)).toBe(true);
    const openApi = JSON.parse(readFileSync(openApiPath, "utf-8"));
    expect(openApi).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Pracht Cloudflare Example API", version: "1.0.0" },
    });
    expect(readFileSync(openApiUiPath, "utf-8")).toContain('{"url":"/openapi.json"}');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("prerendered SSG pages include client JS and working framework context", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempCloudflareExample();
  try {
    const distDir = resolve(exampleDir, "dist");
    buildCloudflareExample(exampleDir);

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
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("built Cloudflare worker bootstraps WebMCP on a zero-island route", async () => {
  test.setTimeout(120_000);
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-cloudflare-agent-tools-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(basicFixtureDir, exampleDir, {
      filter: fixtureCopyFilter(basicFixtureDir),
      recursive: true,
    });
    const result = spawnSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-strip-types",
        PRACHT_ADAPTER: "cloudflare",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "Cloudflare basic build failed");
    }

    expect(
      JSON.parse(readFileSync(resolve(exampleDir, "dist/server/markdown-manifest.json"), "utf-8")),
    ).toEqual({
      "/": true,
      "/products/1": true,
      "/products/2": true,
      "/products/3": true,
    });

    const serverEntryPath = resolve(exampleDir, "dist/server/server.js");
    const { default: worker } = await import(pathToFileURL(serverEntryPath).href);
    const response = await worker.fetch(
      new Request("https://example.com/agent-tools"),
      { ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } },
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<pracht-island");
    expect(html).toMatch(
      /<script type="module" src="\/assets\/islands-client-[^"]+\.js"><\/script>/,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
