import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht build emits a working Netlify Functions v2 entry", async () => {
  test.setTimeout(120_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-netlify-build-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-strip-types",
        PRACHT_ADAPTER: "netlify",
      },
      stdio: "pipe",
    });

    const wrapperPath = resolve(exampleDir, "netlify/functions/pracht.mjs");
    const serverEntryPath = resolve(exampleDir, "dist/server/server.js");
    expect(existsSync(wrapperPath)).toBe(true);
    expect(existsSync(serverEntryPath)).toBe(true);
    expect(existsSync(resolve(exampleDir, "dist/server/isg-manifest.json"))).toBe(true);
    expect(existsSync(resolve(exampleDir, "dist/client/_pracht/isg.json"))).toBe(false);
    // ISG paths render through the function + durable cache; a snapshot would
    // only be reachable at /pricing/index.html, serving stale content forever.
    expect(existsSync(resolve(exampleDir, "dist/client/pricing/index.html"))).toBe(false);

    const source = readFileSync(wrapperPath, "utf-8");
    expect(source).toContain('import handler from "../../dist/server/server.js"');
    expect(source).toContain('"path": "/*"');
    expect(source).toContain('"excludedPath"');
    expect(source).toContain('"/assets/*"');
    expect(source).toContain('"includedFiles"');
    expect(source).toContain('"../../dist/client/index.html"');
    expect(source).toContain('"../../dist/client/docs/index.html"');
    expect(source).toContain('"../../dist/client/robots.txt"');
    expect(source).not.toContain('"../../dist/client/**"');
    expect(source).toContain('"!../../dist/client/assets/**"');
    expect(source).toContain('"!../../dist/client/_pracht/**"');
    expect(source).not.toMatch(/"\.\.\/\.\.\/dist\/client\/assets\//);
    expect(source).not.toMatch(/"\.\.\/\.\.\/dist\/client\/_pracht\//);
    expect(source).toContain('"nodeBundler": "esbuild"');
    expect(readFileSync(serverEntryPath, "utf-8")).toContain('buildTarget = "netlify"');

    // /assets/* bypasses the function, so the publish directory must carry the
    // immutable asset policy and security headers through `_headers`.
    const headersFile = readFileSync(resolve(exampleDir, "dist/client/_headers"), "utf-8");
    expect(headersFile).toContain(
      "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
    );
    expect(headersFile).toContain("  X-Content-Type-Options: nosniff");

    const previousStaticDir = process.env.PRACHT_STATIC_DIR;
    try {
      process.env.PRACHT_STATIC_DIR = resolve(exampleDir, "dist/client");
      const { default: handler } = await import(pathToFileURL(wrapperPath).href);
      const context = { waitUntil() {} };

      const html = await handler(new Request("https://example.com/"), context);
      expect(html.status).toBe(200);
      expect(html.headers.get("x-pracht-shell")).toBe("public");
      expect(html.headers.get("netlify-cdn-cache-control")).toContain("durable");
      // Netlify-Vary owns the route-state transport; standard Vary owns the
      // Markdown representation because Netlify rejects Accept there.
      expect(html.headers.get("netlify-vary")).toBe(
        "query=_data,header=x-pracht-route-state-request",
      );
      expect(html.headers.get("vary")).toContain("Accept");
      expect(await html.text()).toContain("Pracht starts with an explicit app manifest.");

      const markdown = await handler(
        new Request("https://example.com/", { headers: { accept: "text/markdown" } }),
        context,
      );
      expect(markdown.headers.get("content-type")).toContain("text/markdown");
      expect(await markdown.text()).toContain("# Pracht Example");

      // This dynamic SSG route has no module-level `markdown` export. Route
      // metadata declares that middleware owns negotiation, so every concrete
      // path must still bypass bundled HTML and reach the middleware.
      const productMarkdown = await handler(
        new Request("https://example.com/products/1", {
          headers: { accept: "text/markdown" },
        }),
        context,
      );
      expect(productMarkdown.headers.get("content-type")).toContain("text/markdown");
      expect(productMarkdown.headers.get("vary")).toContain("Accept");
      expect(await productMarkdown.text()).toBe("# Product 1\n");

      const api = await handler(new Request("https://example.com/api/health"), context);
      expect(api.headers.get("cache-control")).toBe("private, no-cache");
      await expect(api.json()).resolves.toEqual({ status: "ok" });

      const isg = await handler(new Request("https://example.com/pricing?visitor=1"), context);
      expect(isg.status).toBe(200);
      expect(isg.headers.get("netlify-cdn-cache-control")).toContain("max-age=3600");
      expect(isg.headers.get("netlify-cache-tag")).toContain("pracht:path:%2Fpricing");
      expect(isg.headers.get("netlify-vary")).toBe(
        "query=_data,header=x-pracht-route-state-request",
      );

      const trailingSlashIsg = await handler(
        new Request("https://example.com/pricing/?visitor=2"),
        context,
      );
      expect(trailingSlashIsg.status).toBe(308);
      expect(trailingSlashIsg.headers.get("location")).toBe("/pricing?visitor=2");

      // Client navigations fetch route state with a request header on the page
      // URL; the response must be JSON and must never enter the durable cache.
      const routeState = await handler(
        new Request("https://example.com/pricing", {
          headers: { "x-pracht-route-state-request": "1" },
        }),
        context,
      );
      expect(routeState.headers.get("content-type")).toContain("application/json");
      expect(routeState.headers.has("netlify-cdn-cache-control")).toBe(false);

      // A cross-site `?_data=1` navigation lacks browser provenance, so the
      // framework answers with the HTML document. It shares a CDN cache key
      // with first-party JSON fetches (modulo Netlify-Vary), so it must never
      // become durable-cacheable.
      const crossSiteData = await handler(
        new Request("https://example.com/?_data=1", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
        context,
      );
      expect(crossSiteData.headers.get("content-type")).toContain("text/html");
      const crossSiteCdnPolicy = crossSiteData.headers.get("netlify-cdn-cache-control");
      expect(crossSiteCdnPolicy === null || crossSiteCdnPolicy === "private").toBe(true);

      const missing = await handler(new Request("https://example.com/no-such-page"), context);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("private, no-cache");
    } finally {
      if (previousStaticDir === undefined) delete process.env.PRACHT_STATIC_DIR;
      else process.env.PRACHT_STATIC_DIR = previousStaticDir;
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
