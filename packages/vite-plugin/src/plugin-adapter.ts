import type { Plugin } from "vite";

/**
 * An adapter object that bridges pracht's platform-agnostic core to a specific
 * deployment target.  Built-in adapters are provided by `@pracht/adapter-node`,
 * `@pracht/adapter-cloudflare`, and `@pracht/adapter-vercel`.  You can also
 * supply a custom adapter that conforms to this interface.
 */
export interface PrachtAdapter {
  /** A short identifier used at build time (e.g. "node", "cloudflare", "vercel"). */
  id: string;
  /**
   * Extra import statements that must appear at the top of the generated
   * `virtual:pracht/server` module.  Return an empty string if none are needed.
   */
  serverImports: string;
  /**
   * Returns the JavaScript source code appended to the generated
   * `virtual:pracht/server` module.  This is where the adapter wires up its
   * request handler or default export.
   */
  createServerEntryModule(): string;
  /**
   * Additional Vite plugins the adapter needs (e.g. `@cloudflare/vite-plugin`).
   * Returned plugins are appended to the plugin array returned by `pracht()`.
   */
  vitePlugins?(): Plugin[] | Promise<Plugin[]>;
  /**
   * If true, the adapter owns dev-server request handling and the vite-plugin
   * will not install its own SSR middleware. Used when the adapter contributes
   * a Vite plugin that runs the dev server in a platform-specific runtime
   * (e.g. Cloudflare workerd via `@cloudflare/vite-plugin`).
   */
  ownsDevServer?: boolean;
}

export function createDefaultNodeAdapter(): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
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
        "",
        "export const handler = createNodeRequestHandler({",
        "  app: resolvedApp,",
        "  registry,",
        "  staticDir,",
        "  isgManifest,",
        "  apiRoutes,",
        "  clientEntryUrl: clientEntryUrl ?? undefined,",
        "  cssManifest,",
        "  jsManifest,",
        "});",
        "",
        "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
        "if (entryHref && import.meta.url === entryHref) {",
        "  const server = createServer(handler);",
        "  const port = Number(process.env.PORT ?? 3000);",
        "  server.listen(port, () => {",
        "    console.log(`pracht node server listening on http://localhost:${port}`);",
        "  });",
        "}",
        "",
      ].join("\n");
    },
  };
}
