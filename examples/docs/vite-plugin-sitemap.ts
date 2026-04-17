/**
 * Vite plugin that emits sitemap.xml from a pracht route manifest.
 *
 * The plugin reads the route manifest file as text and extracts `route("…")`
 * paths by regex, rather than importing it — importing routes.ts from the
 * vite config would pull lazy `() => import("*.md")` calls through esbuild
 * while bundling the config, and those transforms don't run there.
 *
 * - Dev: serves /sitemap.xml from the dev middleware.
 * - Build: emits dist/client/sitemap.xml as a build asset.
 */

import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export interface SitemapPluginOptions {
  /** Site origin without trailing slash, e.g. https://pracht.dev */
  origin: string;
  /** Absolute path to the route manifest file (typically src/routes.ts). */
  routesFile: string;
  /** Optional last-modified ISO date applied to every entry. */
  lastmod?: string;
  /** Extra paths to include (e.g. manually-managed sections). */
  extraPaths?: string[];
}

function extractRoutePaths(source: string): string[] {
  // Match route("/path", …) / route('/path', …). Skips dynamic segments.
  const pattern = /\broute\s*\(\s*(["'])([^"']+)\1/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const path = match[2];
    if (!path.startsWith("/")) continue;
    if (path.includes(":") || path.includes("*")) continue;
    paths.push(path);
  }
  return paths;
}

function buildSitemap(origin: string, paths: string[], lastmod?: string): string {
  const seen = new Set<string>();
  const entries = paths
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .sort()
    .map((path) => {
      const loc = `${origin}${path === "/" ? "" : path}`;
      const lm = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lm}\n  </url>`;
    });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...entries,
    `</urlset>`,
    ``,
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sitemap(options: SitemapPluginOptions): Plugin {
  const origin = options.origin.replace(/\/$/, "");
  const generate = () => {
    const source = readFileSync(options.routesFile, "utf-8");
    const paths = [...extractRoutePaths(source), ...(options.extraPaths ?? [])];
    return buildSitemap(origin, paths, options.lastmod);
  };

  return {
    name: "pracht-sitemap",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configureServer(server) {
      server.middlewares.use("/sitemap.xml", (_req, res) => {
        res.setHeader("content-type", "application/xml; charset=utf-8");
        res.end(generate());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: generate(),
      });
    },
  };
}
