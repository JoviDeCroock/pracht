import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

test("previte build emits a deployable Node server entry", async () => {
  test.setTimeout(120_000);

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const fixtureDir = resolve(repoRoot, "examples/basic");
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "previte-node-build-"));
  const exampleDir = resolve(tempDir, "project");
  const distDir = resolve(exampleDir, "dist");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/basic/${entry}`),
      );
    },
    recursive: true,
  });
  rmSync(distDir, { force: true, recursive: true });

  execFileSync(process.execPath, [resolve(repoRoot, "packages/cli/bin/previte.js"), "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      PREVITE_ADAPTER: "node",
    },
    stdio: "pipe",
  });

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
    await expect(homeResponse.text()).resolves.toContain(
      "Previte starts with an explicit app manifest.",
    );

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
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

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
