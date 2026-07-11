import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { FunctionComponent } from "preact";

import { buildHref, matchAppRoute } from "./app.ts";
import { installHydrationMismatchWarning } from "./hydration-mismatch.ts";
import { markHydrating } from "./hydration.ts";
import {
  beginLoadingNavigation,
  createNavigationLocation,
  settleNavigation,
} from "./navigation-state.ts";
import { getCachedRouteState } from "./prefetch-cache.ts";
import { registerPrefetchTarget } from "./prefetch-api.ts";
import type { ModuleWarmFn } from "./prefetch-api.ts";
import { PRESERVE_SCROLL_ATTRIBUTE, VIEW_TRANSITION_ATTRIBUTE } from "./runtime-constants.ts";
import { normalizeSpeculation, supportsSpeculationRules } from "./runtime-speculation.ts";
import {
  createScrollPositionStore,
  generateScrollKey,
  getSessionScrollStorage,
  readScrollKeyFromHistoryState,
  withScrollKeyInHistoryState,
} from "./scroll-restoration.ts";
import type {
  NavigateOptions,
  ResolvedPrachtApp,
  RouteId,
  RouteMatch,
  RouteParams,
  RouteTarget,
} from "./types.ts";
import {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  routeNeedsServerFetch,
} from "./runtime-client-fetch.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import { type PrachtHydrationState, PrachtRuntimeProvider } from "./runtime-context.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";

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
    __PRACHT_NAVIGATE__?: InternalNavigateFn;
    __PRACHT_ROUTER_READY__?: boolean;
  }
}

type ModuleMap = Record<string, () => Promise<unknown>>;

export interface NavigateFn {
  (to: string, options?: NavigateOptions): Promise<void>;
  <TRoute extends RouteId>(to: RouteTarget<TRoute>, options?: NavigateOptions): Promise<void>;
}

interface InternalNavigateOptions extends NavigateOptions {
  _popstate?: boolean;
  _reloadRouteState?: boolean;
}

interface InternalNavigateFn {
  (to: string, options?: InternalNavigateOptions): Promise<void>;
  <TRoute extends RouteId>(
    to: RouteTarget<TRoute>,
    options?: InternalNavigateOptions,
  ): Promise<void>;
}

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

  if (import.meta.env?.DEV) {
    installHydrationMismatchWarning();
  }

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
  let latestNavigationId = 0;
  let activeNavigationAbort: AbortController | null = null;

  // --- Scroll restoration -------------------------------------------------
  // The router owns scrolling: positions are keyed per history entry (via a
  // key stored on `history.state`) and persisted in sessionStorage so they
  // survive reloads and back-navigation from external documents.
  const scrollStore = createScrollPositionStore(getSessionScrollStorage());
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  let currentScrollKey = readScrollKeyFromHistoryState(history.state) ?? "";
  const hadExistingScrollKey = currentScrollKey !== "";
  if (!hadExistingScrollKey) {
    currentScrollKey = generateScrollKey();
    try {
      history.replaceState(
        withScrollKeyInHistoryState(history.state, currentScrollKey),
        "",
        window.location.href,
      );
    } catch {
      // Some embedders restrict history mutation; scroll restoration then
      // degrades to scroll-to-top, which matches the previous behavior.
    }
  }

  function saveScrollPosition(): void {
    scrollStore.set(currentScrollKey, { x: window.scrollX, y: window.scrollY });
  }

  window.addEventListener("pagehide", saveScrollPosition);

  function restoreOrResetScroll(
    opts: InternalNavigateOptions | undefined,
    browserUrl: string,
  ): void {
    if (opts?.preserveScroll) return;

    if (opts?._popstate) {
      const saved = scrollStore.get(currentScrollKey);
      window.scrollTo(saved?.x ?? 0, saved?.y ?? 0);
      return;
    }

    const hashIndex = browserUrl.indexOf("#");
    if (hashIndex !== -1) {
      let id = browserUrl.slice(hashIndex + 1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Keep the raw fragment when it is not valid percent-encoding.
      }
      const hashTarget = id ? document.getElementById(id) : null;
      if (hashTarget && typeof hashTarget.scrollIntoView === "function") {
        hashTarget.scrollIntoView();
        return;
      }
    }

    window.scrollTo(0, 0);
  }

  // Runs after the DOM for a newly committed route state is in place —
  // scroll restoration must not race Preact's asynchronous re-render (the
  // outgoing page's height would clamp the restored position).
  let afterCommitCallback: (() => void) | null = null;

  function RouterRoot({ initialState }: { initialState: RouteRenderState }) {
    const [routeState, setRouteState] = useState(initialState);
    updateRouteState = setRouteState;
    const navigateValue = useMemo(() => navigate, []);

    const { Shell, Component, componentProps, data, params, routeId, url, version } = routeState;

    useLayoutEffect(() => {
      if (!afterCommitCallback) return;
      const callback = afterCommitCallback;
      afterCommitCallback = null;
      callback();
    }, [version]);
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
        { data, params, routeId, routes: app.routes, stateVersion: version, url },
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
    const ErrorBoundary = routeMod.ErrorBoundary ?? resolvedShell?.ErrorBoundary;
    const Component = (
      state.error ? ErrorBoundary : (routeMod.Component ?? DefaultComponent)
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

  async function navigate(to: string | RouteTarget, opts?: InternalNavigateOptions): Promise<void> {
    const navigationId = ++latestNavigationId;
    activeNavigationAbort?.abort();
    const abortController = new AbortController();
    activeNavigationAbort = abortController;

    const navigationTarget =
      typeof to === "string" ? to : buildHref(app.routes, to.route, to as never);
    const target = resolveBrowserRouteTarget(navigationTarget);
    if (!target) {
      const safeUrl = parseSafeNavigationUrl(navigationTarget, window.location.href);
      if (safeUrl) {
        window.location.href = safeUrl.toString();
      } else if (navigationTarget) {
        console.error(`[pracht] refused to navigate to unsafe URL: ${navigationTarget}`);
      }
      return;
    }

    const match = matchAppRoute(app, target.pathname);
    if (!match) {
      // No client route — fall back to full page load
      window.location.href = target.browserUrl;
      return;
    }

    if (match.route.hydration === "islands" || match.route.hydration === "none") {
      // Islands / no-hydration routes are served as regular documents
      // (MPA-style): their pages never load the client runtime, so client
      // rendering them here would produce a page that loses its islands
      // bootstrap. Full document navigation keeps both worlds consistent.
      window.location.href = target.browserUrl;
      return;
    }

    // Expose pending state through useNavigation(). The token makes the
    // finally-settle a no-op when a newer navigation supersedes this one.
    const navigationToken = beginLoadingNavigation(createNavigationLocation(target.browserUrl));
    try {
      // Start route-state fetch and module imports in parallel
      let statePromise: Promise<RouteStateResult>;
      if (routeNeedsServerFetch(match.route)) {
        statePromise = opts?._reloadRouteState
          ? fetchPrachtRouteState(target.requestUrl, {
              cache: "reload",
              signal: abortController.signal,
            })
          : (getCachedRouteState(target.requestUrl) ??
            fetchPrachtRouteState(target.requestUrl, { signal: abortController.signal }));
      } else {
        statePromise = Promise.resolve({ type: "data" as const, data: undefined });
      }
      const routeModPromise = startRouteImport(match);
      const shellModPromise = startShellImport(match);

      // Await route state (need it to handle redirects before rendering)
      let state: { data: unknown; error?: SerializedRouteError | null } = {
        data: undefined,
        error: null,
      };
      try {
        const result = await statePromise;
        if (navigationId !== latestNavigationId) return;
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
        if (abortController.signal.aborted || navigationId !== latestNavigationId) return;
        // Network error — full page load as fallback
        window.location.href = target.browserUrl;
        return;
      }

      if (navigationId !== latestNavigationId) return;

      if (!opts?._popstate) {
        // Remember where the outgoing history entry was scrolled to before
        // this entry is replaced / a new one is pushed.
        saveScrollPosition();
        if (opts?.replace) {
          history.replaceState(
            withScrollKeyInHistoryState(history.state, currentScrollKey),
            "",
            target.browserUrl,
          );
        } else {
          const nextScrollKey = generateScrollKey();
          history.pushState(
            withScrollKeyInHistoryState(null, nextScrollKey),
            "",
            target.browserUrl,
          );
          currentScrollKey = nextScrollKey;
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
      if (navigationId !== latestNavigationId) return;

      if (!routeState) {
        window.location.href = target.browserUrl;
        return;
      }

      const commit = () => {
        afterCommitCallback = () => restoreOrResetScroll(opts, target.browserUrl);
        applyRouteState(routeState);
      };
      const useViewTransition = opts?.viewTransition ?? app.viewTransitions === true;
      await commitWithOptionalViewTransition(commit, useViewTransition);
    } finally {
      settleNavigation(navigationToken);
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

    // If the destination route opted into `prerender` speculation rules, let
    // the browser perform a normal navigation so it can activate the
    // prerendered document. Intercepting here would cancel the activation
    // and force a redundant SPA fetch of the route-state JSON.
    const targetMatch = matchAppRoute(app, url.pathname);
    if (targetMatch && supportsSpeculationRules()) {
      const spec = normalizeSpeculation(targetMatch.route.speculation);
      if (spec?.mode === "prerender") return;
    }

    e.preventDefault();
    const navOptions: NavigateOptions = {};
    if (anchor.hasAttribute(PRESERVE_SCROLL_ATTRIBUTE)) navOptions.preserveScroll = true;
    if (anchor.hasAttribute(VIEW_TRANSITION_ATTRIBUTE)) navOptions.viewTransition = true;
    navigate(url.pathname + url.search + url.hash, navOptions);
  });

  window.addEventListener("popstate", () => {
    // The history entry already changed, but the on-screen scroll position
    // still belongs to the entry we are leaving — save it under its key
    // before adopting the new entry's key.
    saveScrollPosition();
    let nextScrollKey = readScrollKeyFromHistoryState(history.state);
    if (!nextScrollKey) {
      nextScrollKey = generateScrollKey();
      try {
        history.replaceState(
          withScrollKeyInHistoryState(history.state, nextScrollKey),
          "",
          window.location.href,
        );
      } catch {
        // History mutation restricted — restoration degrades to scroll-to-top.
      }
    }
    currentScrollKey = nextScrollKey;

    navigate(window.location.pathname + window.location.search + window.location.hash, {
      _popstate: true,
    });
  });

  window.__PRACHT_NAVIGATE__ = navigate;
  window.__PRACHT_ROUTER_READY__ = true;
  // Public hydration marker for test tooling: server-rendered pages look
  // interactive before the client router takes over, so tests (Playwright,
  // etc.) should wait for `html[data-pracht-hydrated]` before driving forms —
  // interacting earlier triggers native form submits instead of JS handlers.
  document.documentElement.setAttribute("data-pracht-hydrated", "true");

  // Restore the scroll position after a reload or a return from an external
  // document — with `history.scrollRestoration = "manual"` the browser no
  // longer does this for us.
  if (hadExistingScrollKey) {
    const savedPosition = scrollStore.get(currentScrollKey);
    if (savedPosition) {
      window.scrollTo(savedPosition.x, savedPosition.y);
    }
  }

  const warmModules: ModuleWarmFn = (match) => {
    startRouteImport(match);
    startShellImport(match);
  };
  registerPrefetchTarget(app, warmModules);
  void import("./prefetch.ts").then(({ setupPrefetching }) => {
    setupPrefetching(app, warmModules);
  });
}

interface ViewTransitionLike {
  updateCallbackDone?: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

/**
 * Commit a navigation's DOM update, optionally wrapped in
 * `document.startViewTransition()`. Falls back to a plain commit when view
 * transitions are disabled or unsupported. Resolves once the DOM update has
 * been applied (not when the transition animation finishes).
 */
async function commitWithOptionalViewTransition(
  commit: () => void,
  useViewTransition: boolean,
): Promise<void> {
  const doc = document as ViewTransitionDocument;
  if (!useViewTransition || typeof doc.startViewTransition !== "function") {
    commit();
    return;
  }

  let committed = false;
  let transition: ViewTransitionLike | undefined;
  try {
    transition = doc.startViewTransition(async () => {
      committed = true;
      commit();
      // Preact flushes state updates asynchronously — wait a macrotask so the
      // new route's DOM is in place before the transition captures snapshots.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  } catch {
    // Defensive: a broken partial implementation must not break navigation.
  }

  try {
    await transition?.updateCallbackDone;
  } catch {
    // The transition was skipped — the DOM update itself still applied.
  }

  if (!committed) {
    commit();
  }
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
