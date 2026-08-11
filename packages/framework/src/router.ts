import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { FunctionComponent } from "preact";

import { buildHref, matchResolvedRoute, normalizeRoutePath } from "./route-matching.ts";
import {
  decodeFragmentId,
  findFragmentTarget,
  focusFragmentTarget,
  scrollToFragmentTarget,
} from "./fragment-navigation.ts";
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
import {
  NOT_FOUND_ROUTE_ID,
  PRESERVE_SCROLL_ATTRIBUTE,
  VIEW_TRANSITION_ATTRIBUTE,
} from "./runtime-constants.ts";
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
import {
  type PrachtHydrationState,
  PrachtRuntimeProvider,
  RouteDataContext,
} from "./runtime-context.ts";
import { resolveRouteSearch } from "./route-search.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";

interface RouteRenderState {
  Shell: FunctionComponent | null;
  Component: FunctionComponent;
  componentProps: Record<string, unknown>;
  data: unknown;
  params: RouteParams;
  replaceDocument?: boolean;
  routeId: string;
  search: unknown;
  url: string;
  version: number;
}

function ClientRouteErrorFallback({ error }: { error: Error }) {
  return error.message;
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

  // The document (path + query) the router currently has rendered. Used on
  // popstate to tell a same-document fragment navigation apart from a
  // traversal that needs the route re-resolved.
  let currentDocumentPath = window.location.pathname + window.location.search;

  function restoreOrResetScroll(
    opts: InternalNavigateOptions | undefined,
    browserUrl: string,
  ): void {
    if (opts?.preserveScroll) return;

    if (opts?._popstate) {
      const saved = scrollStore.get(currentScrollKey);
      if (saved) {
        window.scrollTo(saved.x, saved.y);
        return;
      }
      // Nothing saved for this entry — fall through to the fragment lookup
      // rather than hard-resetting to the top, so traversing onto a URL that
      // carries a fragment still lands on the fragment.
    }

    const hashIndex = browserUrl.indexOf("#");
    if (hashIndex !== -1) {
      const hashTarget = findFragmentTarget(document, browserUrl.slice(hashIndex));
      if (hashTarget) {
        scrollToFragmentTarget(hashTarget);
        return;
      }
    }

    window.scrollTo(0, 0);
  }

  /**
   * Scroll to (and focus) a fragment the way a browser would.
   *
   * When nothing matches there is no indicated part to scroll to: the browser
   * goes to the top of the document only for the empty fragment and the
   * legacy `#top`, and stays exactly where it is otherwise.
   */
  function scrollToFragment(hash: string): void {
    const target = findFragmentTarget(document, hash);
    if (target) {
      scrollToFragmentTarget(target);
      return;
    }

    const id = decodeFragmentId(hash);
    if (id === "" || id.toLowerCase() === "top") {
      window.scrollTo(0, 0);
    }
  }

  /**
   * Commit an in-page fragment navigation from a link click.
   *
   * The browser does this itself, but only the first time. Clicking a link to
   * the fragment you are already at reuses the current history entry instead
   * of pushing a new one, and `popstate` alone cannot tell that reuse apart
   * from a back/forward traversal — the entry already carries a scroll key, so
   * the router would read it as a traversal and restore the position saved for
   * it, undoing the browser's jump. (The Navigation API's `navigationType`
   * would separate the two, but it is not available everywhere.)
   *
   * Owning the whole interaction here makes a repeat click scroll every time
   * and leaves `popstate` to mean "traversal", which is what the scroll-key
   * logic assumes. The guard in the popstate handler stays as the fallback for
   * fragment entries created some other way (`location.hash = …`).
   */
  function commitFragmentNavigation(url: URL, preserveScroll: boolean): void {
    const previousUrl = window.location.href;

    if (url.href !== previousUrl) {
      // The entry being left keeps the position it was actually at.
      saveScrollPosition();
      const nextScrollKey = generateScrollKey();
      try {
        history.pushState(
          withScrollKeyInHistoryState(null, nextScrollKey),
          "",
          url.pathname + url.search + url.hash,
        );
        currentScrollKey = nextScrollKey;
      } catch {
        // History mutation restricted — the scroll below still lands, the
        // entry just is not recorded.
      }
    }
    currentDocumentPath = url.pathname + url.search;

    if (!preserveScroll) {
      scrollToFragment(url.hash);
    }

    // `pushState` fires neither `hashchange` nor `popstate`, so app code
    // listening for the platform event still needs to hear about this.
    const nextUrl = window.location.href;
    if (nextUrl !== previousUrl) {
      dispatchHashChange(previousUrl, nextUrl);
    }
  }

  // Runs after the DOM for a newly committed route state is in place —
  // scroll restoration must not race Preact's asynchronous re-render (the
  // outgoing page's height would clamp the restored position).
  let afterCommitCallback: (() => void) | null = null;

  // The route component's `data` prop is a snapshot taken when the route state
  // was resolved, but revalidation (`useRevalidate()`, `<Form capability>`, the
  // capability-settled listener) commits new data to the runtime provider
  // instead of re-resolving the route. Reading the provider here keeps the prop
  // and `useRouteData()` on the same value, so a component that destructures
  // `{ data }` sees a refresh exactly like a hook consumer does.
  function RouteComponent({
    Component,
    componentProps,
  }: {
    Component: FunctionComponent;
    componentProps: Record<string, unknown>;
  }) {
    const runtime = useContext(RouteDataContext);
    // Error and SPA-pending states pass props that carry no loader data
    // (`{ error }` / `{}`); only the loaded-data shape tracks the provider.
    const props =
      runtime && "data" in componentProps
        ? { ...componentProps, data: runtime.data }
        : componentProps;
    return h(Component as FunctionComponent<Record<string, unknown>>, props);
  }

  function RouterRoot({ initialState }: { initialState: RouteRenderState }) {
    const [routeState, setRouteState] = useState(initialState);
    updateRouteState = setRouteState;
    const navigateValue = useMemo(() => navigate, []);

    const { Shell, Component, componentProps, data, params, routeId, search, url, version } =
      routeState;

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
        { data, params, routeId, routes: app.routes, search, stateVersion: version, url },
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
    renderUnhandledError = false,
  ): Promise<RouteRenderState | null> {
    const routeMod = await (routeModPromise ?? startRouteImport(match));
    if (!routeMod) return null;
    let search: unknown = {};
    let searchError: Error | null = null;
    try {
      search = await resolveRouteSearch(
        routeMod,
        new URL(currentUrl, window.location.origin).searchParams,
      );
    } catch (error) {
      searchError = error instanceof Error ? error : new Error(String(error));
    }

    let Shell: FunctionComponent | null = null;
    const resolvedShell = await (shellModPromise ?? startShellImport(match));
    if (resolvedShell) {
      Shell = resolvedShell.Shell;
    }

    const DefaultComponent = typeof routeMod.default === "function" ? routeMod.default : undefined;
    const routeError = state.error ? deserializeRouteError(state.error) : searchError;
    const ErrorBoundary = routeMod.ErrorBoundary ?? resolvedShell?.ErrorBoundary;
    const usesClientErrorFallback = routeError && !ErrorBoundary && renderUnhandledError;
    const Component = (
      routeError
        ? (ErrorBoundary ?? (renderUnhandledError ? ClientRouteErrorFallback : undefined))
        : (routeMod.Component ?? DefaultComponent)
    ) as FunctionComponent<any>;
    if (!Component) return null;

    const componentProps: Record<string, unknown> = routeError
      ? { error: routeError }
      : { data: state.data, params: match.params, search };

    return {
      Shell: usesClientErrorFallback ? null : Shell,
      Component,
      componentProps,
      data: state.data,
      params: match.params,
      replaceDocument: Boolean(usesClientErrorFallback),
      routeId: match.route.id ?? "",
      search,
      url: currentUrl,
      version: ++routeStateVersion,
    };
  }

  async function resolveSpaPendingState(
    match: RouteMatch,
    currentUrl: string,
    routeModPromise?: Promise<any> | null,
    shellModPromise?: Promise<any> | null,
  ): Promise<RouteRenderState | null> {
    const [routeMod, resolvedShell] = await Promise.all([
      routeModPromise ?? startRouteImport(match),
      shellModPromise ?? startShellImport(match),
    ]);
    if (!routeMod) return null;
    if (!resolvedShell) return null;

    let search: unknown;
    try {
      search = await resolveRouteSearch(
        routeMod,
        new URL(currentUrl, window.location.origin).searchParams,
      );
    } catch {
      // The server only emits a pending SPA document after successful search
      // validation. If the isomorphic client schema disagrees, leave that
      // document untouched until the route-state response resolves and the
      // normal error-boundary path can take over.
      return null;
    }

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
      search,
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

    const match = matchResolvedRoute(app, target.pathname);
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
          if (result.error.status === 404 && app.notFound) {
            const routeModule = (await routeModPromise?.catch(() => null)) as {
              ErrorBoundary?: unknown;
            } | null;
            if (!routeModule?.ErrorBoundary) {
              window.location.href = target.browserUrl;
              return;
            }
          }

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
        const hashIndex = target.browserUrl.indexOf("#");
        currentDocumentPath =
          hashIndex === -1 ? target.browserUrl : target.browserUrl.slice(0, hashIndex);
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

  const hydratedTarget = resolveBrowserRouteTarget(options.initialState.url);
  const browserTarget = resolveBrowserRouteTarget(
    window.location.pathname + window.location.search + window.location.hash,
  );
  // Prerendered HTML is keyed by pathname, so its embedded URL may not carry
  // the visitor's query. Prefer the live browser URL when it still identifies
  // the same document; retain the hydration URL as a defensive fallback for a
  // mismatched bootstrap or test harness.
  const initialTarget =
    browserTarget &&
    hydratedTarget &&
    normalizeRoutePath(browserTarget.pathname) === normalizeRoutePath(hydratedTarget.pathname)
      ? browserTarget
      : hydratedTarget;
  const initialRequestUrl = initialTarget?.requestUrl ?? options.initialState.url;
  const initialBrowserUrl = initialTarget?.browserUrl ?? options.initialState.url;
  const initialPathname = initialTarget?.pathname ?? options.initialState.url;
  // The not-found page is served at a URL that matches no route, so matching
  // cannot find it — the hydration state's reserved route id does.
  const initialMatch =
    matchResolvedRoute(app, initialPathname) ??
    (options.initialState.routeId === NOT_FOUND_ROUTE_ID && app.notFound
      ? { route: app.notFound, params: {}, pathname: initialPathname }
      : undefined);
  if (initialMatch) {
    const initialRoutePromise = startRouteImport(initialMatch);
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
        initialRoutePromise,
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
        initialRoutePromise,
        initialShellPromise,
        true,
      );
      if (resolvedState) {
        applyRouteState(resolvedState);
      }
    } else {
      const initialRouteState = await resolveRouteState(
        initialMatch,
        state,
        initialRequestUrl,
        initialRoutePromise,
        initialShellPromise,
        true,
      );
      if (initialRouteState) {
        if (initialRouteState.replaceDocument) {
          root.replaceChildren();
          render(h(RouterRoot, { initialState: initialRouteState }), root);
        } else if (initialMatch.route.render === "spa") {
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
    if (!href) return;

    // Resolve relative URLs. A bare `#fragment` resolves against the full
    // current URL — against the origin alone it would lose the path.
    const isFragmentHref = href.startsWith("#");
    let url: URL;
    try {
      url = new URL(href, isFragmentHref ? window.location.href : window.location.origin);
    } catch {
      return;
    }

    // Skip external origins
    if (url.origin !== window.location.origin) return;

    // In-page fragment navigation: same document, only the fragment differs.
    // Handled before the speculation check below because no document is
    // fetched here, so prerendering has nothing to activate.
    const isSameDocument =
      url.pathname + url.search === window.location.pathname + window.location.search;
    if (isSameDocument && (url.hash !== "" || isFragmentHref)) {
      e.preventDefault();
      commitFragmentNavigation(url, anchor.hasAttribute(PRESERVE_SCROLL_ATTRIBUTE));
      return;
    }

    // If the destination route opted into `prerender` speculation rules, let
    // the browser perform a normal navigation so it can activate the
    // prerendered document. Intercepting here would cancel the activation
    // and force a redundant SPA fetch of the route-state JSON.
    const targetMatch = matchResolvedRoute(app, url.pathname);
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
    // before adopting the new entry's key. A same-document fragment
    // navigation fires popstate *before* the browser scrolls to the fragment,
    // so this still records where the outgoing entry actually was.
    saveScrollPosition();

    let nextScrollKey = readScrollKeyFromHistoryState(history.state);
    const nextDocumentPath = window.location.pathname + window.location.search;

    // A fragment navigation the router did not commit itself — `location.hash
    // = "…"`, or an anchor click it never saw — fires popstate for a brand new
    // entry rather than a traversal. Two signals separate the cases: the router
    // stamps a scroll key into `history.state` for every entry it creates, so a
    // missing key means this entry came from somewhere else; and a fragment
    // navigation cannot change the path or query. Requiring both means an
    // entry whose state was wiped by app code (a stray
    // `history.replaceState(null, …)`) is still re-resolved when the route
    // really did change.
    //
    // Link clicks no longer reach this branch: they are committed in the click
    // handler, because a repeat click on the fragment you are already at reuses
    // the entry and so arrives here indistinguishable from a traversal.
    const isFragmentNavigation = !nextScrollKey && nextDocumentPath === currentDocumentPath;

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

    if (isFragmentNavigation) {
      // The same route is already rendered, so there is nothing to
      // re-resolve, and this entry has no saved position to restore. The
      // browser's own scroll to the fragment is about to happen — treating
      // this as a traversal would undo it. Focus still needs help: see
      // `focusFragmentTarget`.
      const fragmentTarget = findFragmentTarget(document, window.location.hash);
      if (fragmentTarget) focusFragmentTarget(fragmentTarget);
      return;
    }

    currentDocumentPath = nextDocumentPath;
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

/**
 * Fire the `hashchange` the platform would have fired for a fragment
 * navigation the router intercepted. Both URLs are absolute, as the event's
 * `oldURL`/`newURL` are specified to be.
 */
function dispatchHashChange(oldURL: string, newURL: string): void {
  let event: Event;
  try {
    event = new HashChangeEvent("hashchange", { oldURL, newURL });
  } catch {
    // Environments without the HashChangeEvent constructor still get the
    // notification, just without the URL details.
    event = new Event("hashchange");
  }
  window.dispatchEvent(event);
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
