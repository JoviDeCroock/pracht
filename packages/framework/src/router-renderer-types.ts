import type { FunctionComponent } from "preact";

import type { NavigateFn } from "./router-navigation.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { ResolvedPrachtApp, RouteMatch, RouteParams } from "./types.ts";

export type RouterModuleMap = Record<string, () => Promise<unknown>>;

export interface RouteRenderState {
  Shell: FunctionComponent | null;
  Component: FunctionComponent;
  componentProps: Record<string, unknown>;
  data: unknown;
  params: RouteParams;
  routeId: string;
  url: string;
  version: number;
}

export interface RouteModule {
  Component?: unknown;
  ErrorBoundary?: unknown;
  default?: unknown;
}

export interface ShellModule {
  ErrorBoundary?: unknown;
  Loading?: unknown;
  Shell?: unknown;
}

export interface ClientRouteRendererOptions {
  app: ResolvedPrachtApp;
  routeModules: RouterModuleMap;
  shellModules: RouterModuleMap;
  root: HTMLElement;
  findModuleKey: (modules: RouterModuleMap, file: string) => string | null;
  getNavigate: () => NavigateFn;
}

export interface ClientRouteRenderer {
  afterCommit(callback: () => void): void;
  applyRouteState(state: RouteRenderState): void;
  mountRouteState(state: RouteRenderState, mode: "hydrate" | "render"): void;
  resolveRouteState(
    match: RouteMatch,
    state: { data: unknown; error?: SerializedRouteError | null },
    currentUrl: string,
    routeModPromise?: Promise<unknown> | null,
    shellModPromise?: Promise<unknown> | null,
  ): Promise<RouteRenderState | null>;
  resolveSpaPendingState(
    match: RouteMatch,
    currentUrl: string,
    shellModPromise?: Promise<unknown> | null,
  ): Promise<RouteRenderState | null>;
  startRouteImport(match: RouteMatch): Promise<unknown> | null;
  startShellImport(match: RouteMatch): Promise<unknown> | null;
  syncHydratedUrl(initialState: RouteRenderState, search: string): void;
  warmModules(match: RouteMatch): void;
}
