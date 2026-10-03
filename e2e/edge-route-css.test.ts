import { execFileSync } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

// Edge adapters build the server for a Worker runtime, where Vite's default is
// a single chunk. A route that does not fully hydrate takes its stylesheets
// from that build, so in one chunk it had none of its own: the deployed page
// rendered its class names with no rules behind them, on Vercel and Cloudflare
// only. Node, dev and the unit tests all looked fine.
//
// examples/islands covers every shape that depends on it — `hydration:
// "islands"`, `hydration: "none"`, an island rendered as a plain component, a
// component shared by an island and a route. Built for Vercel, each page has to
// carry the rules the Node build gives it, and no more.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");
const vercelAdapterEntry = resolve(repoRoot, "packages/adapter-vercel/dist/index.mjs");

const PAGES = ["/", "/lazy", "/static", "/static-island"];

const LINK_RE = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;
const HREF_RE = /\bhref="([^"]+)"/;
const CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;

function documentClasses(html: string, staticDir: string): string[] {
  const css = [...html.matchAll(LINK_RE)].map((match) => {
    const href = match[0].match(HREF_RE)?.[1] ?? "";
    const file = resolve(staticDir, href.replace(/^\//, ""));
    expect(existsSync(file), `${href} is linked but was not deployed`).toBe(true);
    return readFileSync(file, "utf-8");
  });
  return [...new Set([...css.join("\n").matchAll(CLASS_RE)].map((match) => match[1]!))].sort();
}

function pageHtml(staticDir: string, path: string): string {
  return readFileSync(resolve(staticDir, `.${path === "/" ? "" : path}/index.html`), "utf-8");
}

function copyAndBuild(tempDir: string, name: string, viteConfig?: string): string {
  const exampleDir = resolve(tempDir, name);
  cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
  if (viteConfig) writeFileSync(resolve(exampleDir, "vite.config.ts"), viteConfig);
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
    stdio: "pipe",
  });
  return exampleDir;
}

test("an edge build links each page's own stylesheets, like the Node build", async () => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-edge-route-css-"));

  try {
    const nodeDir = copyAndBuild(tempDir, "node");
    const edgeDir = copyAndBuild(
      tempDir,
      "vercel",
      [
        'import { defineConfig } from "vite";',
        'import { pracht } from "@pracht/vite-plugin";',
        `import { vercelAdapter } from ${JSON.stringify(pathToFileURL(vercelAdapterEntry).href)};`,
        "",
        "export default defineConfig({ plugins: [pracht({ adapter: vercelAdapter() })] });",
        "",
      ].join("\n"),
    );

    const nodeStatic = resolve(nodeDir, "dist/client");
    const edgeStatic = resolve(edgeDir, ".vercel/output/static");

    for (const path of PAGES) {
      const expected = documentClasses(pageHtml(nodeStatic, path), nodeStatic);
      expect(expected.length, `${path} has rules in the Node build`).toBeGreaterThan(0);
      expect(documentClasses(pageHtml(edgeStatic, path), edgeStatic), path).toEqual(expected);
    }
    // The route that ships no JavaScript and has a stylesheet of its own.
    expect(documentClasses(pageHtml(edgeStatic, "/static"), edgeStatic)).toContain("static-hero");
    // An island's stylesheet stays with the pages that render it.
    expect(documentClasses(pageHtml(edgeStatic, "/static"), edgeStatic)).not.toContain("counter");

    // Rendered per request by the edge function rather than prerendered.
    const { default: edgeHandler } = await import(
      pathToFileURL(resolve(edgeDir, ".vercel/output/functions/render.func/server.js")).href
    );
    const response = await edgeHandler(new Request("https://example.com/ssr"), {
      waitUntil() {},
    });
    expect(response.status).toBe(200);
    const ssrClasses = documentClasses(await response.text(), edgeStatic);
    expect(ssrClasses).toContain("counter");
    expect(ssrClasses).toContain("site-shell");
    expect(ssrClasses).not.toContain("static-hero");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
