import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

function createTempVercelExample(): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-vercel-build-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    return { exampleDir, tempDir };
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

test("pracht build emits a deployable Vercel Build Output setup", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempVercelExample();
  try {
    const vercelDir = resolve(exampleDir, ".vercel/output");
    const configPath = resolve(vercelDir, "config.json");
    const functionConfigPath = resolve(vercelDir, "functions/render.func/.vc-config.json");
    const serverEntryPath = resolve(vercelDir, "functions/render.func/server.js");
    const pricingFunctionDir = resolve(vercelDir, "functions/pricing.func");
    const pricingFunctionConfigPath = resolve(pricingFunctionDir, ".vc-config.json");
    const pricingFunctionEntryPath = resolve(pricingFunctionDir, "_pracht-node-entry.cjs");
    const pricingPrerenderConfigPath = resolve(
      vercelDir,
      "functions/pricing.prerender-config.json",
    );
    const pricingFallbackPath = resolve(vercelDir, "functions/pricing.prerender-fallback.html");
    const staticIndexPath = resolve(vercelDir, "static/index.html");
    const staticPricingPath = resolve(vercelDir, "static/pricing/index.html");

    execFileSync(process.execPath, [cliEntry, "build"], {
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

    const staticOpenApiPath = resolve(vercelDir, "static/openapi.json");
    const staticOpenApiUiPath = resolve(vercelDir, "static/docs/index.html");
    expect(existsSync(staticOpenApiPath)).toBe(true);
    expect(existsSync(staticOpenApiUiPath)).toBe(true);
    const openApi = JSON.parse(readFileSync(staticOpenApiPath, "utf-8"));
    expect(openApi).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Pracht Example API", version: "1.0.0" },
    });
    expect(readFileSync(staticOpenApiUiPath, "utf-8")).toContain('{"url":"/openapi.json"}');

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
        expect.objectContaining({ src: "^/docs/?$", dest: "/docs/index.html" }),
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

    // Vercel rejects a deployment that pairs `.prerender-config.json` with an
    // edge function ('Unexpected function type "EdgeFunction"'), so ISG routes
    // must be emitted as Node serverless functions.
    const pricingFunctionConfig = JSON.parse(readFileSync(pricingFunctionConfigPath, "utf-8"));
    expect(pricingFunctionConfig).toMatchObject({
      handler: "_pracht-node-entry.cjs",
      launcherType: "Nodejs",
      runtime: expect.stringMatching(/^nodejs\d+\.x$/),
    });
    expect(JSON.parse(readFileSync(resolve(pricingFunctionDir, "package.json"), "utf-8"))).toEqual({
      type: "module",
    });
    expect(existsSync(resolve(pricingFunctionDir, "server.js"))).toBe(true);

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
    expect(functionSource).toContain("createVercelNodeListener");

    const { default: edgeHandler } = await import(pathToFileURL(serverEntryPath).href);
    const agentToolsResponse = await edgeHandler(new Request("https://example.com/agent-tools"), {
      waitUntil() {},
    });
    expect(agentToolsResponse.status).toBe(200);
    const agentToolsHtml = await agentToolsResponse.text();
    expect(agentToolsHtml).not.toContain("<pracht-island");
    expect(agentToolsHtml).toMatch(
      /<script type="module" src="\/assets\/islands-client-[^"]+\.js"><\/script>/,
    );

    // The prerender function runs on Node with the same Web-API-only bundle the
    // edge function uses — drive its launcher the way Vercel's Node launcher
    // does to prove the emitted function boots and renders.
    const { default: nodeListener } = await import(pathToFileURL(pricingFunctionEntryPath).href);
    const chunks: Buffer[] = [];
    const responseHeaders: Record<string, string | string[]> = {};
    const res = {
      statusCode: 0,
      setHeader(key: string, value: string | string[]) {
        responseHeaders[key] = value;
      },
      write(chunk: Uint8Array) {
        chunks.push(Buffer.from(chunk));
      },
      end() {},
    };
    await nodeListener(
      {
        headers: { host: "example.com", "x-forwarded-proto": "https" },
        method: "GET",
        url: "/pricing",
        async *[Symbol.asyncIterator]() {},
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(responseHeaders["content-type"]).toContain("text/html");
    expect(Buffer.concat(chunks).toString("utf-8")).toContain("MVP plan");

    // `ssr.target: "webworker"` used to resolve `@pracht/core/env/server` to its
    // browser stub and rewrite its `process.env` fallback to `{}`. The server
    // entry now reaches Vercel's ambient process through globalThis without
    // preserving every raw process.env read in the noExternal edge bundle.
    expect(functionSource).toContain("globalThis.process");
    expect(functionSource).not.toContain('typeof process !== "undefined" && process.env');
    expect(functionSource).not.toContain("@pracht/core/env/server was imported in client code");
    // Vite keeps ownership of NODE_ENV inlining and its mode/NODE_ENV semantics.
    expect(functionSource).not.toContain("process.env.NODE_ENV");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
