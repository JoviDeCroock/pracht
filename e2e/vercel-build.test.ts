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
  const pricingFunctionConfigPath = resolve(vercelDir, "functions/pricing.func/.vc-config.json");
  const pricingPrerenderConfigPath = resolve(vercelDir, "functions/pricing.prerender-config.json");
  const pricingFallbackPath = resolve(vercelDir, "functions/pricing.prerender-fallback.html");
  const staticIndexPath = resolve(vercelDir, "static/index.html");
  const staticPricingPath = resolve(vercelDir, "static/pricing/index.html");

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
  expect(existsSync(pricingFunctionConfigPath)).toBe(true);
  expect(existsSync(pricingPrerenderConfigPath)).toBe(true);
  expect(existsSync(pricingFallbackPath)).toBe(true);
  expect(existsSync(staticIndexPath)).toBe(true);
  expect(existsSync(staticPricingPath)).toBe(false);
  // The ISG manifest must not leak into the publicly served static output.
  expect(existsSync(resolve(vercelDir, "static/_pracht/isg.json"))).toBe(false);
  expect(existsSync(resolve(exampleDir, "dist/client/_pracht/isg.json"))).toBe(false);

  // llms.txt is copied into the Vercel static output alongside the other
  // dist/client files and served by the `handle: filesystem` route.
  const staticLlmsTxtPath = resolve(vercelDir, "static/llms.txt");
  expect(existsSync(staticLlmsTxtPath)).toBe(true);
  expect(readFileSync(staticLlmsTxtPath, "utf-8")).toContain("# Pracht Example");

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
      expect.objectContaining({ src: "^/pricing/?$", dest: "/pricing" }),
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
  const pricingFunctionConfig = JSON.parse(readFileSync(pricingFunctionConfigPath, "utf-8"));
  expect(pricingFunctionConfig).toMatchObject(functionConfig);

  const pricingPrerenderConfig = JSON.parse(readFileSync(pricingPrerenderConfigPath, "utf-8"));
  expect(pricingPrerenderConfig).toMatchObject({
    allowQuery: [],
    expiration: 3600,
    fallback: "pricing.prerender-fallback.html",
    initialStatus: 200,
  });
  expect(pricingPrerenderConfig.bypassToken).toEqual(expect.any(String));

  const functionSource = readFileSync(serverEntryPath, "utf-8");
  expect(functionSource).toContain("vercelFunctionName");
  expect(functionSource).toContain('buildTarget = "vercel"');
  expect(functionSource).toContain("createVercelEdgeHandler");
  expect(functionSource).toContain("async function handle(request, context)");
});
