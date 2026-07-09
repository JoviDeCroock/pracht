import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

test("pracht build emits Worker output deployable by Void", async () => {
  test.setTimeout(120_000);

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const exampleDir = resolve(repoRoot, "examples/void");
  const distDir = resolve(exampleDir, "dist");
  const serverEntryPath = resolve(distDir, "server/server.js");
  const staticIndexPath = resolve(distDir, "client/index.html");
  const voidConfigPath = resolve(exampleDir, "void.json");

  rmSync(distDir, { force: true, recursive: true });

  const result = spawnSync(process.execPath, ["../../packages/cli/bin/pracht.js", "build"], {
    cwd: exampleDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: "pipe",
  });
  expect(result.status).toBe(0);
  const output = result.stdout;

  expect(existsSync(serverEntryPath)).toBe(true);
  expect(existsSync(staticIndexPath)).toBe(true);
  expect(existsSync(voidConfigPath)).toBe(true);
  expect(output).toContain("Void worker");
  expect(output).toContain("void deploy --skip-build");
  // The void example has an ISG route (/pricing); the Void build target must
  // warn that ISG falls back to build-time static output.
  expect(result.stderr).toContain(
    "Void adapter currently serves prerendered ISG HTML as static assets and does not perform runtime revalidation",
  );

  const workerSource = readFileSync(serverEntryPath, "utf-8");
  expect(workerSource).toContain("withRuntimeEnv(env");
  expect(workerSource).toContain("cloudflareAssetsBinding");
  expect(workerSource).toContain('buildTarget = "void"');
  expect(workerSource).toContain("_pracht/headers.json");
  expect(workerSource).toContain("server_default as default");

  const worker = (await import(pathToFileURL(serverEntryPath).href)).default as {
    fetch(
      request: Request,
      env: Record<string, unknown>,
      executionContext: unknown,
    ): Promise<Response>;
  };
  const env = createMockVoidEnv({
    "pracht:helper": "helper-value",
    "pracht:raw": "raw-value",
  });
  const executionContext = {
    waitUntil() {},
    passThroughOnException() {},
  };

  const routeResponse = await worker.fetch(
    new Request("https://example.com/bindings"),
    env,
    executionContext,
  );
  expect(routeResponse.status).toBe(200);
  expect(await routeResponse.text()).toContain("Raw KV: raw-value");

  const apiResponse = await worker.fetch(
    new Request("https://example.com/api/void-kv"),
    env,
    executionContext,
  );
  expect(apiResponse.status).toBe(200);
  await expect(apiResponse.json()).resolves.toEqual({ value: "helper-value" });
});

function createMockVoidEnv(values: Record<string, string>): Record<string, unknown> {
  return {
    ASSETS: {
      fetch: async () => new Response("not found", { status: 404 }),
    },
    KV: {
      async get(key: string) {
        return values[key] ?? null;
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
      async getWithMetadata(key: string) {
        return { value: values[key] ?? null, metadata: null };
      },
    },
  };
}
