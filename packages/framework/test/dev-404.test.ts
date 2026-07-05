import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDevNotFoundHtml } from "../src/dev-404.ts";

const routes = [
  { path: "/", render: "ssg" },
  { path: "/pricing", render: "isg" },
  { path: "/products/:id", render: "ssr" },
  { path: "/settings", render: "spa" },
  { path: "/implicit", render: null },
];

describe("buildDevNotFoundHtml", () => {
  it("shows the requested path and lists every route with its render mode", () => {
    const html = buildDevNotFoundHtml({
      apiRoutes: [{ path: "/api/health" }],
      requestedPath: "/nope",
      routes,
    });

    expect(html).toContain("No route matches");
    expect(html).toContain("/nope");
    expect(html).toContain("/products/:id");
    expect(html).toContain("mode-ssg");
    expect(html).toContain("mode-isg");
    expect(html).toContain("mode-ssr");
    expect(html).toContain("mode-spa");
    expect(html).toContain("/api/health");
  });

  it("links static routes but not dynamic patterns", () => {
    const html = buildDevNotFoundHtml({ requestedPath: "/nope", routes });

    expect(html).toContain('<a class="path" href="/pricing">/pricing</a>');
    expect(html).not.toContain('href="/products/:id"');
    expect(html).toContain('<span class="path dynamic">/products/:id</span>');
  });

  it("treats an undeclared render mode as ssr", () => {
    const html = buildDevNotFoundHtml({ requestedPath: "/nope", routes });

    expect(html).toContain('href="/implicit"');
    expect(html).toMatch(/\/implicit<\/a><\/td><td><span class="mode mode-ssr"/);
  });

  it("escapes the requested path and route patterns", () => {
    const html = buildDevNotFoundHtml({
      requestedPath: '/<script>alert("xss")</script>',
      routes: [{ path: '/"><img>', render: "ssr" }],
    });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="/"><img>"');
  });

  it("renders an empty state when no routes are registered", () => {
    const html = buildDevNotFoundHtml({ requestedPath: "/nope", routes: [] });

    expect(html).toContain("No page routes are registered.");
    expect(html).not.toContain("API routes");
  });
});

describe("dev-404 production isolation", () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const productionEntries = ["index.ts", "server.ts", "client.ts", "browser.ts", "manifest.ts"];

  it("is not reachable from any production entry point", () => {
    for (const entry of productionEntries) {
      const reachable = collectRelativeImports(resolve(srcDir, entry));
      expect(
        [...reachable].filter((file) => file.endsWith("dev-404.ts")),
        `${entry} must not (transitively) import dev-404.ts`,
      ).toEqual([]);
    }
  });
});

/** Walk static + dynamic relative import specifiers transitively. */
function collectRelativeImports(entryFile: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entryFile) || !existsSync(entryFile)) {
    return seen;
  }
  seen.add(entryFile);

  const source = readFileSync(entryFile, "utf-8");
  const specifiers = [
    ...source.matchAll(/from\s+["'](\.[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);

  for (const specifier of specifiers) {
    collectRelativeImports(resolve(dirname(entryFile), specifier), seen);
  }

  return seen;
}
