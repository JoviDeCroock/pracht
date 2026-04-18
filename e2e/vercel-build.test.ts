import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

test("pracht build emits a deployable Vercel Build Output setup", async () => {
  test.setTimeout(120_000);

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const exampleDir = resolve(repoRoot, "examples/basic");
  const distDir = resolve(exampleDir, "dist");
  const vercelDir = resolve(exampleDir, ".vercel/output");
  const configPath = resolve(vercelDir, "config.json");
  const functionConfigPath = resolve(vercelDir, "functions/render.func/.vc-config.json");
  const serverEntryPath = resolve(vercelDir, "functions/render.func/server.js");
  const staticIndexPath = resolve(vercelDir, "static/index.html");

  rmSync(distDir, { force: true, recursive: true });
  rmSync(vercelDir, { force: true, recursive: true });

  execFileSync(process.execPath, ["../../packages/cli/bin/pracht.js", "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      PRACHT_ADAPTER: "vercel",
    },
    stdio: "pipe",
  });

  expect(existsSync(configPath)).toBe(true);
  expect(existsSync(functionConfigPath)).toBe(true);
  expect(existsSync(serverEntryPath)).toBe(true);
  expect(existsSync(staticIndexPath)).toBe(true);

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  expect(config.version).toBe(3);
  expect(config.routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: "/(.*)",
        has: [{ type: "header", key: "x-pracht-route-state-request", value: "1" }],
        dest: "/render",
      }),
      expect.objectContaining({
        src: "/(.*)",
        has: [{ type: "query", key: "_data", value: "1" }],
        dest: "/render",
      }),
      expect.objectContaining({ src: "^/$", dest: "/index.html" }),
      expect.objectContaining({ handle: "filesystem" }),
      expect.objectContaining({ src: "/(.*)", dest: "/render" }),
    ]),
  );
  expect(config.headers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "/",
        headers: expect.arrayContaining([
          {
            key: "x-pracht-shell",
            value: "public",
          },
        ]),
      }),
    ]),
  );

  const functionConfig = JSON.parse(readFileSync(functionConfigPath, "utf-8"));
  expect(functionConfig).toMatchObject({
    runtime: "edge",
    entrypoint: "server.js",
  });

  const functionSource = readFileSync(serverEntryPath, "utf-8");
  expect(functionSource).toContain("vercelFunctionName");
  expect(functionSource).toContain('buildTarget = "vercel"');
  expect(functionSource).toContain("async function handle(request, context)");
});
