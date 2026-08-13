/**
 * Shared resolved-app-graph serialization.
 *
 * Both `pracht inspect` (CLI) and the dev-only `/_pracht` devtools endpoint
 * (Vite plugin) consume this facade so they always report the same graph.
 * Module loading and file reading are injected by the caller to keep every
 * serializer platform-neutral.
 */

import { serializeApiRoutes } from "./app-graph-api.ts";
import { serializeCapabilities } from "./app-graph-capabilities.ts";
import { serializeAppRoutes } from "./app-graph-routes.ts";
import type { AppGraph, AppGraphModuleAccess } from "./app-graph-types.ts";
import { resolveMcpEndpoint } from "./mcp-config.ts";
import type { ResolvedApiRoute, ResolvedPrachtApp } from "./types.ts";

export {
  API_METHOD_ORDER,
  detectApiExports,
  detectApiExportsStatic,
  detectApiMethods,
  type ApiRouteExports,
} from "./api-export-detection.ts";
export { serializeApiRoutes, serializeApiRoutesStatic } from "./app-graph-api.ts";
export { serializeCapabilities } from "./app-graph-capabilities.ts";
export { serializeAppRoutes } from "./app-graph-routes.ts";
export type {
  AppGraph,
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphModuleAccess,
  AppGraphRoute,
  AppGraphStaticModuleAccess,
  SerializeApiRoutesOptions,
  SerializeCapabilitiesOptions,
} from "./app-graph-types.ts";

export async function buildAppGraph(
  options: {
    apiRoutes?: readonly ResolvedApiRoute[];
    app: ResolvedPrachtApp;
  } & AppGraphModuleAccess,
): Promise<AppGraph> {
  const notFound = options.app.notFound;
  return {
    api: await serializeApiRoutes(options.apiRoutes ?? [], options),
    capabilities: await serializeCapabilities(options.app.capabilities, options),
    mcpEndpoint: resolveMcpEndpoint(options.app.agents),
    notFound: notFound ? serializeAppRoutes([notFound])[0] : null,
    routes: serializeAppRoutes(options.app.routes),
  };
}
