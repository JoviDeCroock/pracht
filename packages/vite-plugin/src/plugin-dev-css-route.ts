import type { ViteDevServer } from "vite";

import { PRACHT_DEV_MODULE_ID } from "./plugin-assets.ts";
import { createDevCssManifest } from "./plugin-dev-css-graph.ts";
import { injectDevCssLinks } from "./plugin-dev-css-html.ts";

export async function injectDevCssForPath(
  server: ViteDevServer,
  path: string,
  html: string,
): Promise<string> {
  const context = await resolveDevCssContextForPath(server, path);
  const manifest = await createDevCssManifest(server, context);
  return injectDevCssLinks(html, manifest);
}

export async function resolveDevCssContextForPath(
  server: ViteDevServer,
  path: string,
): Promise<Parameters<typeof createDevCssManifest>[1]> {
  const [framework, serverMod] = await Promise.all([
    server.ssrLoadModule("@pracht/core/server"),
    server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
  ]);
  const pathname = new URL(path, "http://localhost").pathname;
  return {
    app: serverMod.resolvedApp,
    matchAppRoute: framework.matchAppRoute,
    pathname,
    registry: serverMod.registry,
  };
}
