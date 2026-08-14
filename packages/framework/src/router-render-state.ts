import type { FunctionComponent } from "preact";

import type { ClientRouteModuleLoader } from "./router-module-loader.ts";
import type {
  ClientRouteRenderer,
  RouteModule,
  RouteRenderState,
  ShellModule,
} from "./router-renderer-types.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import type { RouteMatch } from "./types.ts";

export type ClientRouteStateResolver = Pick<
  ClientRouteRenderer,
  "resolveRouteState" | "resolveSpaPendingState"
>;

export function createClientRouteStateResolver(
  moduleLoader: ClientRouteModuleLoader,
): ClientRouteStateResolver {
  let routeStateVersion = 0;

  async function resolveRouteState(
    match: RouteMatch,
    state: { data: unknown; error?: SerializedRouteError | null },
    currentUrl: string,
    routeModPromise?: Promise<unknown> | null,
    shellModPromise?: Promise<unknown> | null,
  ): Promise<RouteRenderState | null> {
    const routeMod = (await (routeModPromise ??
      moduleLoader.startRouteImport(match))) as RouteModule | null;
    if (!routeMod) return null;

    let Shell: FunctionComponent | null = null;
    const resolvedShell = (await (shellModPromise ??
      moduleLoader.startShellImport(match))) as ShellModule | null;
    if (resolvedShell) {
      Shell = resolvedShell.Shell as FunctionComponent;
    }

    const DefaultComponent = typeof routeMod.default === "function" ? routeMod.default : undefined;
    const ErrorBoundary = routeMod.ErrorBoundary ?? resolvedShell?.ErrorBoundary;
    const Component = (state.error ? ErrorBoundary : (routeMod.Component ?? DefaultComponent)) as
      | FunctionComponent
      | undefined;
    if (!Component) return null;

    const componentProps: Record<string, unknown> = state.error
      ? { error: deserializeRouteError(state.error) }
      : { data: state.data, params: match.params };

    return {
      Shell,
      Component,
      componentProps,
      data: state.data,
      params: match.params,
      routeId: match.route.id ?? "",
      url: currentUrl,
      version: ++routeStateVersion,
    };
  }

  async function resolveSpaPendingState(
    match: RouteMatch,
    currentUrl: string,
    shellModPromise?: Promise<unknown> | null,
  ): Promise<RouteRenderState | null> {
    const resolvedShell = (await (shellModPromise ??
      moduleLoader.startShellImport(match))) as ShellModule | null;
    if (!resolvedShell) return null;

    const Shell = (resolvedShell.Shell as FunctionComponent) ?? null;
    const Loading = resolvedShell.Loading as FunctionComponent | null;
    if (!Shell && !Loading) return null;

    return {
      Shell,
      Component: Loading ?? (() => null),
      componentProps: {},
      data: undefined,
      params: match.params,
      routeId: match.route.id ?? "",
      url: currentUrl,
      version: ++routeStateVersion,
    };
  }

  return {
    resolveRouteState,
    resolveSpaPendingState,
  };
}
