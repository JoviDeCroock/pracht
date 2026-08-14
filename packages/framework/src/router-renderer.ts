/** Stable composition facade for client route rendering and module resolution. */

import { createClientRouteModuleLoader } from "./router-module-loader.ts";
import { createClientRouteStateResolver } from "./router-render-state.ts";
import type { ClientRouteRenderer, ClientRouteRendererOptions } from "./router-renderer-types.ts";
import { createClientRouteView } from "./router-view.ts";

export type {
  ClientRouteRenderer,
  ClientRouteRendererOptions,
  RouteRenderState,
  RouterModuleMap,
} from "./router-renderer-types.ts";

export function createClientRouteRenderer(
  options: ClientRouteRendererOptions,
): ClientRouteRenderer {
  const moduleLoader = createClientRouteModuleLoader(options);
  const stateResolver = createClientRouteStateResolver(moduleLoader);
  const view = createClientRouteView(options);

  return {
    afterCommit: view.afterCommit,
    applyRouteState: view.applyRouteState,
    mountRouteState: view.mountRouteState,
    resolveRouteState: stateResolver.resolveRouteState,
    resolveSpaPendingState: stateResolver.resolveSpaPendingState,
    startRouteImport: moduleLoader.startRouteImport,
    startShellImport: moduleLoader.startShellImport,
    syncHydratedUrl: view.syncHydratedUrl,
    warmModules: moduleLoader.warmModules,
  };
}
