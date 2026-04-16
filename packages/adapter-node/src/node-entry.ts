import type { PrachtAdapter } from "@pracht/vite-plugin";

export interface NodeServerEntryModuleOptions {
  port?: number;
}

export function createNodeServerEntryModule(options: NodeServerEntryModuleOptions = {}): string {
  const port = options.port ?? 3000;

  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { createNodeRequestHandler } from "@pracht/adapter-node";',
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
    "",
    "export const handler = createNodeRequestHandler({",
    "  app: resolvedApp,",
    "  registry,",
    "  staticDir,",
    "  isgManifest,",
    "  headersManifest,",
    "  apiRoutes,",
    "  clientEntryUrl: clientEntryUrl ?? undefined,",
    "  cssManifest,",
    "  jsManifest,",
    "});",
    "",
    "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
    "if (entryHref && import.meta.url === entryHref) {",
    "  const server = createServer(handler);",
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
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return createNodeServerEntryModule(options);
    },
  };
}
