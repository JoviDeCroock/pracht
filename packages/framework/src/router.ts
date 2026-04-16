import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import type { FunctionComponent } from "preact";

import { matchAppRoute } from "./app.ts";
import { markHydrating } from "./hydration.ts";
import { getCachedRouteState, setupPrefetching } from "./prefetch.ts";
import type { ModuleWarmFn } from "./prefetch.ts";
import type { ResolvedPrachtApp, RouteMatch, RouteParams } from "./types.ts";
import {
  deserializeRouteError,
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  PrachtRuntimeProvider,
} from "./runtime.ts";
import type { SerializedRouteError, PrachtHydrationState } from "./runtime.ts";

interface RouteRenderState {
  Shell: FunctionComponent | null;
  Component: FunctionComponent;
  componentProps: Record<string, unknown>;
  data: unknown;
  params: RouteParams;
  routeId: string;
  url: string;
  version: number;
}

declare global {
  interface Window {
    __PRACHT_NAVIGATE__?: NavigateFn;
    __PRACHT_ROUTER_READY__?: boolean;
  }
}

type ModuleMap = Record<string, () => Promise<unknown>>;

export type NavigateFn = (to: string, options?: { replace?: boolean }) => Promise<void>;

interface BrowserRouteTarget {
  browserUrl: string;
  pathname: string;
  requestUrl: string;
}

const NavigateContext = createContext<NavigateFn>(async () => {});

export function useNavigate(): NavigateFn {
  return useContext(NavigateContext);
}

export interface InitClientRouterOptions {
  app: ResolvedPrachtApp;
  routeModules: ModuleMap;
  shellModules: ModuleMap;
  initialState: PrachtHydrationState;
  root: HTMLElement;
  findModuleKey: (modules: ModuleMap, file: string) => string | null;
}

export async function initClientRouter(options: InitClientRouterOptions): Promise<void> {
  const { app, routeModules, shellModules, root, findModuleKey } = options;

  const moduleCache = new Map<string, Promise<unknown>>();

  function loadModule(modules: ModuleMap, key: string): Promise<unknown> {
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

  let updateRouteState: ((state: RouteRenderState) => void) | null = null;
  let routeStateVersion = 0;

  function RouterRoot({ initialState }: { initialState: RouteRenderState }) {
    const [routeState, setRouteState] = useState(initialState);
    updateRouteState = setRouteState;
    const navigateValue = useMemo(() => navigate, []);

    const { Shell, Component, componentProps, data, params, routeId, url, version } = routeState;
    const componentTree = Shell
      ? h(
          Shell as FunctionComponent<Record<string, unknown>>,
          null,
          h(Component as FunctionComponent<Record<string, unknown>>, componentProps),
        )
      : h(Component as FunctionComponent<Record<string, unknown>>, componentProps);

    return h(
      NavigateContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: navigateValue },
      h(
        PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
        { data, params, routeId, stateVersion: version, url },
        componentTree,
      ),
    );
  }

  function applyRouteState(routeState: RouteRenderState): void {
    if (updateRouteState) {
      updateRouteState(routeState);
      return;
    }

    render(h(RouterRoot, { initialState: routeState }), root);
  }

  async function resolveRouteState(
    match: RouteMatch,
    state: { data: unknown; error?: SerializedRouteError | null },
    currentUrl: string,
    routeModPromise?: Promise<any> | null,
    shellModPromise?: Promise<any> | null,
  ): Promise<RouteRenderState | null> {
    const routeMod = await (routeModPromise ?? startRouteImport(match));
    if (!routeMod) return null;

    let Shell: FunctionComponent | null = null;
    const resolvedShell = await (shellModPromise ?? startShellImport(match));
    if (resolvedShell) {
      Shell = resolvedShell.Shell;
    }

    const DefaultComponent = typeof routeMod.default === "function" ? routeMod.default : undefined;
    const Component = (
      state.error ? routeMod.ErrorBoundary : (routeMod.Component ?? DefaultComponent)
    ) as FunctionComponent<any>;
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
    shellModPromise?: Promise<any> | null,
  ): Promise<RouteRenderState | null> {
    const resolvedShell = await (shellModPromise ?? startShellImport(match));
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

  function resolveRedirectTarget(location: string): {
    documentUrl?: string;
    externalUrl?: string;
    internalPath?: string;
    isCurrentLocation: boolean;
    unsafe?: boolean;
  } {
    const targetUrl = parseSafeNavigationUrl(location, window.location.href);
    if (!targetUrl) {
      return { isCurrentLocation: false, unsafe: true };
    }
    const fullInternalTarget = targetUrl.pathname + targetUrl.search + targetUrl.hash;
    const internalPath = targetUrl.pathname + targetUrl.search;
    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    const isCurrentLocation =
      targetUrl.origin === window.location.origin && fullInternalTarget === currentPath;

    if (targetUrl.origin !== window.location.origin) {
      return {
        externalUrl: targetUrl.toString(),
        isCurrentLocation: false,
      };
    }

    if (targetUrl.hash) {
      return {
        documentUrl: targetUrl.toString(),
        isCurrentLocation,
      };
    }

    return {
      internalPath,
      isCurrentLocation,
    };
  }

  async function navigate(
    to: string,
    opts?: { replace?: boolean; _popstate?: boolean },
  ): Promise<void> {
    const target = resolveBrowserRouteTarget(to);
    if (!target) {
      window.location.href = to;
      return;
    }

    const match = matchAppRoute(app, target.pathname);
    if (!match) {
      // No client route — fall back to full page load
      window.location.href = target.browserUrl;
      return;
    }

    // Start route-state fetch and module imports in parallel
    const statePromise =
      getCachedRouteState(target.requestUrl) ?? fetchPrachtRouteState(target.requestUrl);
    const routeModPromise = startRouteImport(match);
    const shellModPromise = startShellImport(match);

    // Await route state (need it to handle redirects before rendering)
    let state: { data: unknown; error?: SerializedRouteError | null } = {
      data: undefined,
      error: null,
    };
    try {
      const result = await statePromise;
      if (result.type === "redirect") {
        if (result.location) {
          const redirect = resolveRedirectTarget(result.location);
          if (redirect.unsafe) {
            console.error(`[pracht] refused to navigate to unsafe URL: ${result.location}`);
            return;
          }
          if (redirect.externalUrl) {
            window.location.href = redirect.externalUrl;
            return;
          }

          if (redirect.isCurrentLocation) {
            return;
          }

          if (redirect.documentUrl) {
            window.location.href = redirect.documentUrl;
            return;
          }

          if (redirect.internalPath) {
            await navigate(redirect.internalPath, opts);
            return;
          }

          window.location.href = target.browserUrl;
          return;
        }
        window.location.href = target.browserUrl;
        return;
      }

      if (result.type === "error") {
        state = {
          data: undefined,
          error: result.error,
        };
      } else {
        state = {
          data: result.data,
          error: null,
        };
      }
    } catch {
      // Network error — full page load as fallback
      window.location.href = target.browserUrl;
      return;
    }

    if (!opts?._popstate) {
      if (opts?.replace) {
        history.replaceState(null, "", target.browserUrl);
      } else {
        history.pushState(null, "", target.browserUrl);
      }
    }

    // Module imports started above are already in-flight
    const routeState = await resolveRouteState(
      match,
      state,
      target.requestUrl,
      routeModPromise,
      shellModPromise,
    );
    if (routeState) {
      applyRouteState(routeState);
      window.scrollTo(0, 0);
    } else {
      window.location.href = target.browserUrl;
    }
  }

  const initialTarget = resolveBrowserRouteTarget(options.initialState.url);
  const initialRequestUrl = initialTarget?.requestUrl ?? options.initialState.url;
  const initialBrowserUrl = initialTarget?.browserUrl ?? options.initialState.url;
  const initialMatch = matchAppRoute(app, initialTarget?.pathname ?? options.initialState.url);
  if (initialMatch) {
    const initialShellPromise =
      initialMatch.route.render === "spa" && options.initialState.pending
        ? startShellImport(initialMatch)
        : null;
    let state = {
      data: options.initialState.data,
      error: options.initialState.error ?? null,
    };

    if (initialMatch.route.render === "spa" && options.initialState.pending) {
      // Use query parameter URL to match the <link rel="preload"> tag from SSR
      const dataPromise = fetchPrachtRouteState(initialRequestUrl, { useDataParam: true });

      const pendingState = await resolveSpaPendingState(
        initialMatch,
        initialRequestUrl,
        initialShellPromise,
      );
      if (pendingState) {
        hydrate(h(RouterRoot, { initialState: pendingState }), root);
      }

      try {
        const result = await dataPromise;
        if (result.type === "redirect") {
          const safeRedirect = parseSafeNavigationUrl(result.location, window.location.href);
          if (!safeRedirect) {
            console.error(`[pracht] refused to navigate to unsafe URL: ${result.location}`);
            return;
          }
          window.location.href = safeRedirect.toString();
          return;
        }

        if (result.type === "error") {
          state = {
            data: undefined,
            error: result.error,
          };
        } else {
          state = {
            data: result.data,
            error: null,
          };
        }
      } catch {
        window.location.href = initialBrowserUrl;
        return;
      }

      const resolvedState = await resolveRouteState(
        initialMatch,
        state,
        initialRequestUrl,
        undefined,
        initialShellPromise,
      );
      if (resolvedState) {
        applyRouteState(resolvedState);
      }
    } else {
      const initialRouteState = await resolveRouteState(
        initialMatch,
        state,
        initialRequestUrl,
        undefined,
        initialShellPromise,
      );
      if (initialRouteState) {
        if (initialMatch.route.render === "spa") {
          render(h(RouterRoot, { initialState: initialRouteState }), root);
        } else {
          markHydrating();
          hydrate(h(RouterRoot, { initialState: initialRouteState }), root);
        }
      }
    }
  }

  document.addEventListener("click", (e: MouseEvent) => {
    const anchor = (e.target as Element).closest?.("a");
    if (!anchor) return;

    // Skip modified clicks (new tab, etc.)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;

    // Skip if target opens a new window
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return;

    // Skip download links
    if (anchor.hasAttribute("download")) return;

    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;

    // Resolve relative URLs
    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return;
    }

    // Skip external origins
    if (url.origin !== window.location.origin) return;

    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });

  window.addEventListener("popstate", () => {
    navigate(window.location.pathname + window.location.search + window.location.hash, {
      _popstate: true,
    });
  });

  window.__PRACHT_NAVIGATE__ = navigate;
  window.__PRACHT_ROUTER_READY__ = true;

  const warmModules: ModuleWarmFn = (match) => {
    startRouteImport(match);
    startShellImport(match);
  };
  setupPrefetching(app, warmModules);
}

function resolveBrowserRouteTarget(to: string): BrowserRouteTarget | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) {
      return null;
    }

    return {
      browserUrl: url.pathname + url.search + url.hash,
      pathname: url.pathname,
      requestUrl: url.pathname + url.search,
    };
  } catch {
    return null;
  }
}
