import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import type { FunctionComponent, VNode } from "preact";

import { matchAppRoute } from "./app.ts";
import { markHydrating } from "./hydration.ts";
import { getCachedRouteState, setupPrefetching } from "./prefetch.ts";
import type { ModuleWarmFn } from "./prefetch.ts";
import type { ResolvedPrachtApp, RouteMatch, RouteParams } from "./types.ts";
import { fetchPrachtRouteState, PrachtRuntimeProvider } from "./runtime.ts";
import type { SerializedRouteError, PrachtHydrationState } from "./runtime.ts";

interface RouteRenderState {
  Shell: FunctionComponent | null;
  Component: FunctionComponent<any>;
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

type ModuleMap = Record<string, () => Promise<any>>;

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

  // ------------------------------------------------------------------
  // Module cache — avoids re-importing the same shell/route chunk
  // ------------------------------------------------------------------

  const moduleCache = new Map<string, Promise<any>>();

  function loadModule(modules: ModuleMap, key: string): Promise<any> {
    let cached = moduleCache.get(key);
    if (!cached) {
      cached = modules[key]();
      moduleCache.set(key, cached);
    }
    return cached;
  }

  function startRouteImport(match: RouteMatch): Promise<any> | null {
    const routeKey = findModuleKey(routeModules, match.route.file);
    if (!routeKey) return null;
    return loadModule(routeModules, routeKey);
  }

  function startShellImport(match: RouteMatch): Promise<any> | null {
    if (!match.route.shellFile) return null;
    const shellKey = findModuleKey(shellModules, match.route.shellFile);
    if (!shellKey) return null;
    return loadModule(shellModules, shellKey);
  }

  // ------------------------------------------------------------------
  // Resolve route state (data object, not VNodes)
  // ------------------------------------------------------------------

  let updateRouteState: ((state: RouteRenderState) => void) | null = null;
  let routeStateVersion = 0;

  function RouterRoot({ initialState }: { initialState: RouteRenderState }) {
    const [routeState, setRouteState] = useState(initialState);
    updateRouteState = setRouteState;
    const navigateValue = useMemo(() => navigate, []);

    const { Shell, Component, componentProps, data, params, routeId, url, version } = routeState;
    const componentTree = Shell
      ? h(Shell as any, null, h(Component as any, componentProps))
      : h(Component as any, componentProps);

    return h(
      NavigateContext.Provider as any,
      { value: navigateValue },
      h(
        PrachtRuntimeProvider as any,
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
  } {
    const targetUrl = new URL(location, window.location.href);
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

  // ------------------------------------------------------------------
  // Navigate to a new pathname
  // ------------------------------------------------------------------

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

          window.location.href = result.location;
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

    // Update browser history
    if (!opts?._popstate) {
      if (opts?.replace) {
        history.replaceState(null, "", target.browserUrl);
      } else {
        history.pushState(null, "", target.browserUrl);
      }
    }

    // Update route state — module imports started above are already in-flight
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

  // ------------------------------------------------------------------
  // Dev-mode hydration mismatch monitor (Preact options.__m hook)
  // ------------------------------------------------------------------

  if ((import.meta as any).env?.DEV) {
    const prev = (options as any).__m;
    (options as any).__m = (vnode: VNode, s: string) => {
      const component =
        typeof vnode.type === "function" ? vnode.type.displayName || vnode.type.name : vnode.type;
      const message = `Hydration mismatch in <${component || "Unknown"}>: ${s}`;
      console.warn(`[pracht] ${message}`);
      appendHydrationWarning(message);
      if (prev) prev(vnode, s);
    };
  }

  // ------------------------------------------------------------------
  // Initial hydration — includes NavigateContext so useNavigate works
  // ------------------------------------------------------------------

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
      // Kick off the data fetch in parallel with shell hydration
      const dataPromise = fetchPrachtRouteState(initialRequestUrl);

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
          window.location.href = result.location;
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

  // ------------------------------------------------------------------
  // Global click interception for <a> elements
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // Back / forward navigation
  // ------------------------------------------------------------------

  window.addEventListener("popstate", () => {
    navigate(window.location.pathname + window.location.search + window.location.hash, {
      _popstate: true,
    });
  });

  window.__PRACHT_NAVIGATE__ = navigate;
  window.__PRACHT_ROUTER_READY__ = true;

  // Start prefetching after hydration is complete
  const warmModules: ModuleWarmFn = (match) => {
    startRouteImport(match);
    startShellImport(match);
  };
  setupPrefetching(app, warmModules);
}

// ---------------------------------------------------------------------------
// Dev-only: in-page hydration mismatch warning banner
// ---------------------------------------------------------------------------

const HYDRATION_BANNER_ID = "__pracht_hydration_warnings__";

function appendHydrationWarning(message: string): void {
  let container = document.getElementById(HYDRATION_BANNER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = HYDRATION_BANNER_ID;
    Object.assign(container.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      right: "0",
      maxHeight: "30vh",
      overflow: "auto",
      background: "#2d1b00",
      borderTop: "2px solid #f0ad4e",
      color: "#ffc107",
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: "13px",
      padding: "12px 16px",
      zIndex: "2147483647",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "8px",
    });
    header.innerHTML = '<strong style="color:#f0ad4e">⚠ Hydration Mismatches</strong>';

    const close = document.createElement("button");
    close.textContent = "×";
    Object.assign(close.style, {
      background: "none",
      border: "none",
      color: "#f0ad4e",
      fontSize: "18px",
      cursor: "pointer",
    });
    close.onclick = () => container!.remove();
    header.appendChild(close);

    container.appendChild(header);
    document.body.appendChild(container);
  }

  const entry = document.createElement("div");
  entry.textContent = message;
  Object.assign(entry.style, { padding: "2px 0" });
  container.appendChild(entry);
}

function deserializeRouteError(error: SerializedRouteError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  (
    result as Error & { diagnostics?: SerializedRouteError["diagnostics"]; status?: number }
  ).status = error.status;
  (
    result as Error & { diagnostics?: SerializedRouteError["diagnostics"]; status?: number }
  ).diagnostics = error.diagnostics;
  return result;
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
