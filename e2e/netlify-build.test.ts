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

    const source = readFileSync(wrapperPath, "utf-8");
    expect(source).toContain('import handler from "../../dist/server/server.js"');
    expect(source).toContain('"path": "/*"');
    expect(source).toContain('"excludedPath"');
    expect(source).toContain('"/assets/*"');
    expect(source).toContain('"includedFiles"');
    expect(source).toContain('"dist/client/**"');
    expect(source).toContain('"nodeBundler": "esbuild"');
    expect(readFileSync(serverEntryPath, "utf-8")).toContain('buildTarget = "netlify"');

    const previousStaticDir = process.env.PRACHT_STATIC_DIR;
    try {
      process.env.PRACHT_STATIC_DIR = resolve(exampleDir, "dist/client");
      const { default: handler } = await import(pathToFileURL(wrapperPath).href);
      const context = { waitUntil() {} };

      const html = await handler(new Request("https://example.com/"), context);
      expect(html.status).toBe(200);
      expect(html.headers.get("x-pracht-shell")).toBe("public");
      expect(html.headers.get("netlify-cdn-cache-control")).toContain("durable");
      expect(await html.text()).toContain("Pracht starts with an explicit app manifest.");

      const markdown = await handler(
        new Request("https://example.com/", { headers: { accept: "text/markdown" } }),
        context,
      );
      expect(markdown.headers.get("content-type")).toContain("text/markdown");
      expect(await markdown.text()).toContain("# Pracht Example");

      const api = await handler(new Request("https://example.com/api/health"), context);
      expect(api.headers.get("cache-control")).toBe("private, no-cache");
      await expect(api.json()).resolves.toEqual({ status: "ok" });

      const isg = await handler(new Request("https://example.com/pricing?visitor=1"), context);
      expect(isg.status).toBe(200);
      expect(isg.headers.get("netlify-cdn-cache-control")).toContain("max-age=3600");
      expect(isg.headers.get("netlify-cache-tag")).toContain("pracht:path:%2Fpricing");
    } finally {
      if (previousStaticDir === undefined) delete process.env.PRACHT_STATIC_DIR;
      else process.env.PRACHT_STATIC_DIR = previousStaticDir;
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
