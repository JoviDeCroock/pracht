import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht build emits a deployable Node server entry", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempExampleDir("pracht-node-build-");
  const distDir = resolve(exampleDir, "dist");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");

  rmSync(distDir, { force: true, recursive: true });

  buildExample(exampleDir, { PRACHT_ADAPTER: "node" });

  expect(existsSync(serverEntryPath)).toBe(true);

  const serverSource = readFileSync(serverEntryPath, "utf-8");
  expect(serverSource).toContain('buildTarget = "node"');
  expect(serverSource).toContain("createNodeRequestHandler");
  expect(serverSource).toContain("createServer(handler)");

  const port = 4317;
  const server = spawn(process.execPath, [serverEntryPath], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: "pipe",
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/`);

    const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get("x-pracht-shell")).toBe("public");
    const homeHtml = await homeResponse.text();
    expect(homeHtml).toContain("Pracht starts with an explicit app manifest.");
    expect(homeHtml).not.toContain("/@pracht/client.js");
    expect(homeHtml).toMatch(/<script type="module" src="\/assets\/client-[^"]+\.js"><\/script>/);
    expect(homeHtml).toContain('rel="modulepreload"');

    // Dynamic SSG routes should be prerendered as static HTML files
    for (const id of ["1", "2", "3"]) {
      const htmlPath = resolve(exampleDir, `dist/client/products/${id}/index.html`);
      expect(existsSync(htmlPath)).toBe(true);

      const productResponse = await fetch(`http://127.0.0.1:${port}/products/${id}`);
      expect(productResponse.status).toBe(200);
      const productHtml = await productResponse.text();
      expect(productHtml).toContain("Price:");
    }

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(apiResponse.status).toBe(200);
    await expect(apiResponse.json()).resolves.toEqual({ status: "ok" });

    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { cookie: "session=1" },
    });
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.headers.get("x-pracht-shell")).toBe("app");
    const dashboardHtml = await dashboardResponse.text();
    expect(dashboardHtml).toContain("Ada Lovelace");
    expect(dashboardHtml).not.toContain("/@pracht/client.js");
    expect(dashboardHtml).toMatch(
      /<script type="module" src="\/assets\/client-[^"]+\.js"><\/script>/,
    );
    expect(dashboardHtml).toContain('rel="modulepreload"');

    const pricingResponse = await fetch(`http://127.0.0.1:${port}/pricing`);
    expect(pricingResponse.status).toBe(200);
    expect(pricingResponse.headers.get("x-pracht-shell")).toBe("public");
    expect(pricingResponse.headers.get("vary")).toContain("x-pracht-route-state-request");

    const routeStateResponse = await fetch(`http://127.0.0.1:${port}/pricing`, {
      headers: { "x-pracht-route-state-request": "1" },
    });
    expect(routeStateResponse.status).toBe(200);
    expect(routeStateResponse.headers.get("content-type")).toContain("application/json");
    expect(routeStateResponse.headers.get("x-pracht-shell")).toBeNull();
    expect(routeStateResponse.headers.get("vary")).toContain("x-pracht-route-state-request");
    expect(routeStateResponse.headers.get("cache-control")).toBe("no-store");
    await expect(routeStateResponse.json()).resolves.toEqual({
      data: {
        plan: "MVP",
        refreshedAt: "Build time",
      },
    });

    const homeHeaderRouteStateResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-pracht-route-state-request": "1" },
    });
    expect(homeHeaderRouteStateResponse.status).toBe(200);
    expect(homeHeaderRouteStateResponse.headers.get("content-type")).toContain("application/json");
    await expect(homeHeaderRouteStateResponse.json()).resolves.toEqual({
      data: {
        highlights: [
          "Hybrid route manifest",
          "Per-route rendering modes",
          "Thin deployment adapters",
        ],
      },
    });

    const homeQueryRouteStateResponse = await fetch(`http://127.0.0.1:${port}/?_data=1`);
    expect(homeQueryRouteStateResponse.status).toBe(200);
    expect(homeQueryRouteStateResponse.headers.get("content-type")).toContain("application/json");
    await expect(homeQueryRouteStateResponse.json()).resolves.toEqual({
      data: {
        highlights: [
          "Hybrid route manifest",
          "Per-route rendering modes",
          "Thin deployment adapters",
        ],
      },
    });

    // Hashed assets should have immutable cache headers
    const assetMatch = homeHtml.match(/"(\/assets\/[^"]+)"/);
    expect(assetMatch).toBeTruthy();

    const assetResponse = await fetch(`http://127.0.0.1:${port}${assetMatch![1]}`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // HTML responses should have conservative cache headers
    expect(homeResponse.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("public/ folder assets are copied to dist/client/", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempExampleDir("pracht-public-dir-");
  const distDir = resolve(exampleDir, "dist");

  rmSync(distDir, { force: true, recursive: true });

  const publicDir = resolve(exampleDir, "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(resolve(publicDir, "robots.txt"), "User-agent: *\nAllow: /\n", "utf-8");
  mkdirSync(resolve(publicDir, "icons"), { recursive: true });
  writeFileSync(resolve(publicDir, "icons/favicon.ico"), "fake-ico", "utf-8");

  buildExample(exampleDir, { PRACHT_ADAPTER: "node" });

  expect(existsSync(resolve(exampleDir, "dist/client/robots.txt"))).toBe(true);
  expect(readFileSync(resolve(exampleDir, "dist/client/robots.txt"), "utf-8")).toContain(
    "User-agent",
  );
  expect(existsSync(resolve(exampleDir, "dist/client/icons/favicon.ico"))).toBe(true);

  rmSync(tempDir, { force: true, recursive: true });
});

function createTempExampleDir(prefix: string): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, prefix));
  const exampleDir = resolve(tempDir, "project");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/basic/${entry}`),
      );
    },
    recursive: true,
  });

  return { exampleDir, tempDir };
}

function buildExample(exampleDir: string, env: Record<string, string>): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      ...env,
    },
    stdio: "pipe",
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveDone) => {
    child.once("exit", () => resolveDone());
    setTimeout(() => resolveDone(), 5_000);
  });
}
