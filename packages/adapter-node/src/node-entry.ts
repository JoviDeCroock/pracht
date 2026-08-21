import type { PrachtAdapter } from "@pracht/vite-plugin";

export interface NodeServerEntryModuleOptions {
  canonicalOrigin?: string;
  /** Set when a trusted reverse proxy strips Vite's deploy base before forwarding. */
  basePathStripped?: boolean;
  port?: number;
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBodySize?: number;
  /**
   * Vite-resolvable module path exporting `configureServer(server)`. The
   * generated entry calls it (and awaits it) with the underlying `node:http`
   * server after `createServer()` and before `listen()`, when the entry is
   * run as the process entrypoint. This is the hook for everything pracht's
   * request handler cannot see — chiefly attaching a WebSocket server to the
   * `upgrade` event, which Node routes past the request handler entirely.
   * See docs/ADAPTERS.md § WebSockets for the full recipe including the
   * Origin check.
   */
  configureServerFrom?: string;
  /**
   * Compress responses with brotli or gzip based on `Accept-Encoding`
   * (default: `true`). Set to `false` when a reverse proxy or CDN in front of
   * the Node server already compresses responses.
   */
  compression?: boolean;
}

export function createNodeServerEntryModule(options: NodeServerEntryModuleOptions = {}): string {
  const canonicalOrigin = options.canonicalOrigin ?? null;
  const port = options.port ?? 3000;
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";
  const configureServerImport = options.configureServerFrom
    ? `import { configureServer as configurePrachtServer } from ${JSON.stringify(options.configureServerFrom)};`
    : "const configurePrachtServer = undefined;";

  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { createNodeRequestHandler } from "@pracht/adapter-node";',
    contextImport,
    configureServerImport,
    "",
    "const serverDir = dirname(fileURLToPath(import.meta.url));",
    'const staticDir = resolve(serverDir, "../client");',
    'const isgManifestPath = resolve(serverDir, "isg-manifest.json");',
    "const isgManifest = existsSync(isgManifestPath)",
    '  ? JSON.parse(readFileSync(isgManifestPath, "utf-8"))',
    "  : {};",
    'const headersManifestPath = resolve(serverDir, "headers-manifest.json");',
    "const headersManifest = existsSync(headersManifestPath)",
    '  ? JSON.parse(readFileSync(headersManifestPath, "utf-8"))',
    "  : {};",
    'const markdownManifestPath = resolve(serverDir, "markdown-manifest.json");',
    "const markdownManifest = existsSync(markdownManifestPath)",
    '  ? JSON.parse(readFileSync(markdownManifestPath, "utf-8"))',
    "  : undefined;",
    "",
    "export const handler = createNodeRequestHandler({",
    "  app: resolvedApp,",
    "  registry,",
    "  staticDir,",
    "  isgManifest,",
    "  headersManifest,",
    "  markdownManifest,",
    "  apiRoutes,",
    "  clientEntryUrl: clientEntryUrl ?? undefined,",
    "  islandsEntryUrl: islandsEntryUrl ?? undefined,",
    "  islandsBootstrapRequired,",
    "  cssManifest,",
    "  jsManifest,",
    `  canonicalOrigin: ${JSON.stringify(canonicalOrigin ?? undefined)},`,
    `  basePathStripped: ${JSON.stringify(options.basePathStripped ?? undefined)},`,
    "  createContext: createPrachtContext,",
    `  maxBodySize: ${JSON.stringify(options.maxBodySize ?? undefined)},`,
    `  compression: ${JSON.stringify(options.compression ?? undefined)},`,
    "});",
    "",
    "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
    "if (entryHref && import.meta.url === entryHref) {",
    "  const server = createServer(handler);",
    "  if (configurePrachtServer) await configurePrachtServer(server);",
    `  const port = Number(process.env.PORT ?? ${port});`,
    "  server.listen(port, () => {",
    "    console.log(`pracht node server listening on http://localhost:${port}`);",
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * Create a pracht adapter for Node.js.
 *
 * ```ts
 * import { nodeAdapter } from "@pracht/adapter-node";
 * pracht({ adapter: nodeAdapter() })
 * ```
 */
export function nodeAdapter(options: NodeServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createNodeServerEntryModule(options);
    },
  };
}
