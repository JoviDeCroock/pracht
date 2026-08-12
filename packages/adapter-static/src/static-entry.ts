import type { PrachtAdapter } from "@pracht/vite-plugin";

export interface StaticAdapterOptions {
  /**
   * Additionally emit a SPA fallback document at `dist/client/<fallback>`
   * (conventionally `"200.html"`). Configure your static host to rewrite
   * unmatched URLs to it so deep links into non-prerendered paths (dynamic
   * `render: "spa"` routes) boot the client router. Without a host rewrite
   * the file is inert.
   */
  fallback?: string;
  /** Port used by `pracht preview` / running the generated entry directly. Defaults to 3000. */
  port?: number;
}

const FALLBACK_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

function assertValidStaticAdapterOptions(options: StaticAdapterOptions): void {
  const fallback = options.fallback;
  if (fallback === undefined) return;
  if (!FALLBACK_FILENAME_RE.test(fallback)) {
    throw new Error(
      `staticAdapter({ fallback }) expects a plain HTML file name such as "200.html", got ${JSON.stringify(fallback)}.`,
    );
  }
  if (fallback === "index.html" || fallback === "404.html") {
    throw new Error(
      `staticAdapter({ fallback: ${JSON.stringify(fallback)} }) collides with a reserved output file — ` +
        '"index.html" is the root route and "404.html" is the rendered not-found page. Use "200.html".',
    );
  }
}

export function createStaticServerEntryModule(options: StaticAdapterOptions = {}): string {
  assertValidStaticAdapterOptions(options);
  const fallback = options.fallback ?? null;
  const port = options.port ?? 3000;

  return [
    "",
    "// ---- @pracht/adapter-static ------------------------------------------",
    "// A static export has no runtime server: dist/client is the deployable",
    "// artifact. Everything below exists for `pracht build` (which imports",
    "// this bundle to prerender) and `pracht preview` (which runs this file",
    "// directly to serve dist/client locally).",
    "",
    `export const staticExportConfig = { fallback: ${JSON.stringify(fallback)} };`,
    "",
    "// Rendered to dist/client/404.html (the GitHub Pages / S3 error-document",
    "// convention). Uses an unmatched path so the app's `notFound` page",
    "// renders; returns null when the app declares none.",
    "export async function renderStaticNotFoundHtml() {",
    "  const response = await handlePrachtRequest({",
    "    app: resolvedApp,",
    "    registry,",
    '    request: new Request("http://localhost/__pracht-static-not-found__", { method: "GET" }),',
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    islandsEntryUrl: islandsEntryUrl ?? undefined,",
    "    islandsBootstrapRequired,",
    "    cssManifest,",
    "    jsManifest,",
    "  });",
    '  const contentType = response.headers.get("content-type") ?? "";',
    '  if (response.status !== 404 || !contentType.includes("text/html")) return null;',
    "  return await response.text();",
    "}",
    "",
    "export function renderStaticFallbackHtml() {",
    "  return buildStaticFallbackHtml({ clientEntryUrl: clientEntryUrl ?? undefined });",
    "}",
    "",
    "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
    "if (entryHref && import.meta.url === entryHref) {",
    "  const serverDir = dirname(fileURLToPath(import.meta.url));",
    "  const handler = createStaticPreviewHandler({",
    '    staticDir: resolve(serverDir, "../client"),',
    "    fallback: staticExportConfig.fallback,",
    "  });",
    "  const server = createServer(handler);",
    `  const port = Number(process.env.PORT ?? ${port});`,
    "  server.listen(port, () => {",
    "    console.log(`pracht static preview listening on http://localhost:${port}`);",
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * Create a pracht adapter for pure static export.
 *
 * ```ts
 * import { staticAdapter } from "@pracht/adapter-static";
 * pracht({ adapter: staticAdapter() })
 * ```
 *
 * `pracht build` prerenders every route into `dist/client/` — deploy that
 * directory to any static host. Build-time validation fails closed on
 * anything that needs a server: `render: "ssr"` / `"isg"` routes, API routes,
 * and network-exposed capabilities.
 */
export function staticAdapter(options: StaticAdapterOptions = {}): PrachtAdapter {
  assertValidStaticAdapterOptions(options);
  return {
    id: "static",
    staticTarget: true,
    serverImports: [
      'import { createServer } from "node:http";',
      'import { dirname, resolve } from "node:path";',
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      'import { resolveApp, resolveApiRoutes, handlePrachtRequest, buildStaticFallbackHtml } from "@pracht/core/server";',
      'import { createStaticPreviewHandler } from "@pracht/adapter-static";',
    ].join("\n"),
    createServerEntryModule() {
      return createStaticServerEntryModule(options);
    },
  };
}
