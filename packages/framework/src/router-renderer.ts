import { h, hydrate, render } from "preact";
import { useContext, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { StateUpdater } from "preact/hooks";
import type { FunctionComponent } from "preact";

import { NavigateContext } from "./router-navigation.ts";
import type { NavigateFn } from "./router-navigation.ts";
import { resolveBrowserRouteTarget } from "./router-browser.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import { PrachtRuntimeProvider, RouteDataContext } from "./runtime-context.ts";
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

interface RouteModule {
  Component?: unknown;
  ErrorBoundary?: unknown;
  default?: unknown;
}

interface ShellModule {
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

export function createClientRouteRenderer(
  options: ClientRouteRendererOptions,
): ClientRouteRenderer {
  const { app, routeModules, shellModules, root, findModuleKey, getNavigate } = options;
  const moduleCache = new Map<string, Promise<unknown>>();
  let updateRouteState: ((state: StateUpdater<RouteRenderState>) => void) | null = null;
  let routeStateVersion = 0;
  // Scroll restoration must wait until Preact has committed the destination
  // DOM, otherwise the outgoing page height can clamp the restored position.
  let afterCommitCallback: (() => void) | null = null;

  function loadModule(modules: RouterModuleMap, key: string): Promise<unknown> {
    let cached = moduleCache.get(key);
    if (!cached) {
      cached = modules[key]();
      moduleCache.set(key, cached);
    }
    return cached;
  }

  function startRouteImport(match: RouteMatch): Promise<unknown> | null {
    const routeKey = findModuleKey(routeModules, match.route.file);
    if (!routeKey) return null;
    return loadModule(routeModules, routeKey);
  }

  function startShellImport(match: RouteMatch): Promise<unknown> | null {
    if (!match.route.shellFile) return null;
    const shellKey = findModuleKey(shellModules, match.route.shellFile);
    if (!shellKey) return null;
    return loadModule(shellModules, shellKey);
  }

  // Revalidation updates RouteDataContext without resolving a new route state.
  // Read it here so the component's `data` prop stays aligned with useRouteData().
  function RouteComponent({
    Component,
    componentProps,
  }: {
    Component: FunctionComponent;
    componentProps: Record<string, unknown>;
  }) {
    const runtime = useContext(RouteDataContext);
    // Error and pending states have no loader-data prop to refresh.
    const props =
      runtime && "data" in componentProps
        ? { ...componentProps, data: runtime.data }
        : componentProps;
    return h(Component as FunctionComponent<Record<string, unknown>>, props);
  }

  function RouterRoot({ initialState }: { initialState: RouteRenderState }) {
    const [routeState, setRouteState] = useState(initialState);
    updateRouteState = setRouteState;
    const navigateValue = useMemo(() => getNavigate(), []);

    const { Shell, Component, componentProps, data, params, routeId, url, version } = routeState;

    useLayoutEffect(() => {
      if (!afterCommitCallback) return;
      const callback = afterCommitCallback;
      afterCommitCallback = null;
      callback();
    }, [version]);

    const routeElement = h(RouteComponent, { Component, componentProps });
    const componentTree = Shell
      ? h(Shell as FunctionComponent<Record<string, unknown>>, null, routeElement)
      : routeElement;

    return h(
      NavigateContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: navigateValue },
      h(
        PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
        { data, params, routeId, routes: app.routes, stateVersion: version, url },
        componentTree,
      ),
    );
  }

  function mountRouteState(state: RouteRenderState, mode: "hydrate" | "render"): void {
    const tree = h(RouterRoot, { initialState: state });
    if (mode === "hydrate") hydrate(tree, root);
    else render(tree, root);
  }

  function applyRouteState(state: RouteRenderState): void {
    if (updateRouteState) {
      updateRouteState(state);
      return;
    }
    mountRouteState(state, "render");
  }

  function syncHydratedUrl(initialState: RouteRenderState, search: string): void {
    updateRouteState?.((currentState) => {
      const hydratedTarget = resolveBrowserRouteTarget(currentState.url);
      if (!hydratedTarget) return currentState;
      const nextRequestUrl = hydratedTarget.pathname + search;
      if (currentState.version !== initialState.version || currentState.url === nextRequestUrl) {
        return currentState;
      }
      return { ...currentState, url: nextRequestUrl };
    });
  }

  async function resolveRouteState(
    match: RouteMatch,
    state: { data: unknown; error?: SerializedRouteError | null },
    currentUrl: string,
    routeModPromise?: Promise<unknown> | null,
    shellModPromise?: Promise<unknown> | null,
  ): Promise<RouteRenderState | null> {
    const routeMod = (await (routeModPromise ?? startRouteImport(match))) as RouteModule | null;
    if (!routeMod) return null;

    let Shell: FunctionComponent | null = null;
    const resolvedShell = (await (shellModPromise ??
      startShellImport(match))) as ShellModule | null;
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
      startShellImport(match))) as ShellModule | null;
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

  function afterCommit(callback: () => void): void {
    afterCommitCallback = callback;
  }

  function warmModules(match: RouteMatch): void {
    startRouteImport(match);
    startShellImport(match);
  }

  return {
    afterCommit,
    applyRouteState,
    mountRouteState,
    resolveRouteState,
    resolveSpaPendingState,
    startRouteImport,
    startShellImport,
    syncHydratedUrl,
    warmModules,
  };
}
