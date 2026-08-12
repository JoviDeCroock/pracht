/** Dev-only app-graph inspection endpoints shared by the Vite SSR middleware. */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { ViteDevServer } from "vite";
import type { ResolvedApiRoute, ResolvedPrachtApp } from "@pracht/core";
import { resolveRegistryModule } from "@pracht/core";

import { PRACHT_SERVER_MODULE_ID } from "./plugin-assets.ts";

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";

/**
 * Serve the dev-only `/_pracht` devtools page (or `/_pracht.json`) built from
 * the same resolved app graph that `pracht inspect` reports.
 */
export async function serveDevtools(
  server: ViteDevServer,
  res: ServerResponse,
  options: {
    apiRoutes: ResolvedApiRoute[];
    app: ResolvedPrachtApp;
    url: string;
    wantsJson: boolean;
  },
): Promise<void> {
  const devtools = await server.ssrLoadModule("@pracht/core/devtools");
  // Manifest capability paths are relative to the app file (e.g.
  // `./capabilities/notes-search.ts`), which a bare ssrLoadModule resolves
  // against the Vite root and fails to find. Resolve through the virtual
  // server module's registry first (matching `pracht inspect`), falling back
  // to a direct load for absolute/root-relative paths.
  const serverModule = (await server.ssrLoadModule(PRACHT_SERVER_MODULE_ID)) as {
    registry?: { capabilityModules?: Record<string, () => Promise<unknown>> };
  };
  const capabilityModules = serverModule.registry?.capabilityModules;
  const graph = await devtools.buildAppGraph({
    apiRoutes: options.apiRoutes,
    app: options.app,
    loadModule: async (file: string) => {
      const viaRegistry = await resolveRegistryModule<Record<string, unknown>>(
        capabilityModules,
        file,
      );
      return viaRegistry ?? server.ssrLoadModule(file);
    },
    readSource: (file: string) => readFileSync(resolve(server.config.root, `.${file}`), "utf-8"),
  });

  if (options.wantsJson) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(graph, null, 2));
    return;
  }

  let html = devtools.buildDevtoolsHtml(graph);
  html = await server.transformIndexHtml(options.url, html);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}
