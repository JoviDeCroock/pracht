import { h, hydrate, render } from "preact";
import type { FunctionComponent } from "preact";
import { useContext, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { StateUpdater } from "preact/hooks";

import { resolveBrowserRouteTarget } from "./router-browser.ts";
import { NavigateContext } from "./router-navigation.ts";
import type {
  ClientRouteRenderer,
  ClientRouteRendererOptions,
  RouteRenderState,
} from "./router-renderer-types.ts";
import { PrachtRuntimeProvider, RouteDataContext } from "./runtime-context.ts";

export type ClientRouteView = Pick<
  ClientRouteRenderer,
  "afterCommit" | "applyRouteState" | "mountRouteState" | "syncHydratedUrl"
>;

type ClientRouteViewOptions = Pick<ClientRouteRendererOptions, "app" | "getNavigate" | "root">;

export function createClientRouteView(options: ClientRouteViewOptions): ClientRouteView {
  const { app, root, getNavigate } = options;
  let updateRouteState: ((state: StateUpdater<RouteRenderState>) => void) | null = null;
  // Scroll restoration must wait until Preact has committed the destination
  // DOM, otherwise the outgoing page height can clamp the restored position.
  let afterCommitCallback: (() => void) | null = null;

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

  function afterCommit(callback: () => void): void {
    afterCommitCallback = callback;
  }

  return {
    afterCommit,
    applyRouteState,
    mountRouteState,
    syncHydratedUrl,
  };
}
