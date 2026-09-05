import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { StateUpdater } from "preact/hooks";
import type { FunctionComponent } from "preact";
import type { FontHeadFragments } from "./font.ts";
import { applyFontHeadFragments } from "./runtime-fonts.ts";

import { stripBase } from "./base.ts";
import { buildHrefUntyped, matchResolvedRoute } from "./route-matching.ts";
import {
  decodeFragmentId,
  findFragmentTarget,
  focusFragmentTarget,
  scrollToFragmentTarget,
} from "./fragment-navigation.ts";
import { installHydrationMismatchWarning } from "./hydration-mismatch.ts";
import { readHistoryIndex, withHistoryIndex } from "./navigation-blocker.ts";
import type { BlockerHistoryAction, BlockNavigationFn } from "./navigation-blocker.ts";
import { markHydrating, onHydrationComplete } from "./hydration.ts";
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
import {
  isSpeculationSuppressed,
  normalizeSpeculation,
  supportsSpeculationRules,
} from "./runtime-speculation.ts";
import { MAX_REDIRECT_HOPS, resolveRedirectTarget } from "./router-redirects.ts";
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
  UntypedRouteTarget,
} from "./types.ts";
import {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  routeNeedsServerFetch,
} from "./runtime-client-fetch.ts";
import { IS_STATIC_TARGET } from "./runtime-static.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import {
  type PrachtHydrationState,
  PrachtRuntimeProvider,
  RouteDataContext,
} from "./runtime-context.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";

/**
 * JS prefetching, switched off at build time by
 * `pracht({ client: { prefetch: false } })`.
 *
 * The router reaches the prefetch runtime directly — `initClientRouter()`
 * registers the prefetch target and lazily imports the listeners on every page
 * — so no bundler can decide on its own that an app does not use it. Gating on
 * a define turns the branch, the modules only it reaches, and the lazily
 * imported chunk into dead code.
 *
 * The constant is declared here rather than imported from a shared module
 * because Rollup only folds it into the surrounding branch within one module,
 * and without that fold the dynamic `import()` survives and its chunk still
 * ships. The `typeof` guard keeps the module loadable where the define is
 * absent (unit tests, direct Node imports), so an app that configures nothing
 * behaves exactly as before.
 */
declare const __PRACHT_CLIENT_PREFETCH__: boolean | undefined;

const PREFETCH_ENABLED =
  typeof __PRACHT_CLIENT_PREFETCH__ === "undefined" || __PRACHT_CLIENT_PREFETCH__ !== false;

/**
 * `useBlocker()` guards, compiled out by `client: { navigationGuards: false }`.
 *
 * The guard checks themselves are two `if`s, but the per-history-entry index
 * they need to undo a refused traversal has to be stamped on every entry the
 * router creates, whether or not a guard is ever registered. This define is
 * how an app that never guards a navigation stops paying for that.
 */
declare const __PRACHT_CLIENT_BLOCKER__: boolean | undefined;

const BLOCKER_ENABLED =
  typeof __PRACHT_CLIENT_BLOCKER__ === "undefined" || __PRACHT_CLIENT_BLOCKER__ !== false;

interface RouteRenderState {
  Shell: FunctionComponent | null;
  Component: FunctionComponent;
  capabilities: readonly string[];
  componentProps: Record<string, unknown>;
  data: unknown;
  params: RouteParams;
  routeId: string;
  url: string;
  version: number;
}

declare global {
  interface Window {
    __PRACHT_BLOCK_NAVIGATION__?: BlockNavigationFn;
    __PRACHT_NAVIGATE__?: InternalNavigateFn;
    __PRACHT_ROUTER_READY__?: boolean;
  }
}

type ModuleMap = Record<string, () => Promise<unknown>>;

/**
 * Ask the navigation guard, if `useBlocker()` installed one. Reading a window
 * slot rather than importing `navigation-blocker.ts` is what keeps that store
 * out of the client bundle of an app that renders no guard.
 */
function isBlocked(
  currentHref: string,
  nextHref: string,
  historyAction: BlockerHistoryAction,
  retry: () => void,
): boolean {
  return window.__PRACHT_BLOCK_NAVIGATION__?.(currentHref, nextHref, historyAction, retry) === true;
}

export interface NavigateFn {
  (to: string, options?: NavigateOptions): Promise<void>;
  <TRoute extends RouteId>(to: RouteTarget<TRoute>, options?: NavigateOptions): Promise<void>;
}

interface InternalNavigateOptions extends NavigateOptions {
  /**
   * Skip the navigation guard. Set only when a navigation already cleared one
   * and is continuing under the same approval — a loader redirect resolving to
   * another internal path must not prompt the user a second time.
   */
  _blockerChecked?: boolean;
  _popstate?: boolean;
  _reloadRouteState?: boolean;
  /**
   * Static-export fallback boot (`200.html`): a failed route-state fetch must
   * render without loader data instead of reloading the document — the host
   * would answer the reload with this same fallback document and loop.
   */
  _staticFallback?: boolean;
  /**
   * How many loader redirects this navigation has already followed. Chains
   * longer than `MAX_REDIRECT_HOPS` stop with an error instead of recursing
   * forever, matching how the browser bounds a document redirect chain.
   */
  _redirectHop?: number;
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
  search: string;
  /** `pathname` as the browser shows it — the deploy base included. */
  urlPathname: string;
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
  /** @internal Synchronize page-scoped projections after a route commits. */
  onRouteChange?: (capabilities: readonly string[]) => void;
}

export async function initClientRouter(options: InitClientRouterOptions): Promise<void> {
  const { app, routeModules, shellModules, root, findModuleKey, onRouteChange } = options;

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

  let updateRouteState: ((state: StateUpdater<RouteRenderState>) => void) | null = null;
  let routeStateVersion = 0;
  let activeRouteStateVersion = 0;

  // Which navigation is the live one. `latestNavigationId` is compared at every
  // await point in `navigate()` — a superseded navigation must not commit — and
  // the controller aborts the route-state fetch the one it replaced started.
  let latestNavigationId = 0;
  let activeNavigationAbort: AbortController | null = null;

  // --- History-entry bookkeeping -------------------------------------------
  // Four values that have to stay in step: the scroll key of the entry on
  // screen, that entry's monotonic index, the path+query the router has
  // rendered, and the path+query+fragment a navigation guard is told it is
  // leaving. Every one of them used to be written inline at five call sites,
  // which is how a popstate ends up restoring the wrong scroll position or a
  // guard gets told the wrong "from". They are written only through the named
  // operations below.
  //
  // They stay closure locals rather than moving to a module behind an object:
  // a minifier renames a local to one character and cannot rename a property,
  // and this is the client bundle's critical path — the same reason the
  // defines above are declared in this file.
  //
  // The router owns scrolling: positions are keyed per history entry (via a
  // key stored on `history.state`) and persisted in sessionStorage so they
  // survive reloads and back-navigation from external documents.
  const scrollStore = createScrollPositionStore(getSessionScrollStorage());
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  let currentScrollKey = readScrollKeyFromHistoryState(history.state) ?? "";
  const hadExistingScrollKey = currentScrollKey !== "";
  // Monotonic per-entry index, used only to measure how far a `popstate`
  // traversal moved so a blocked one can be put back. `null` means the entry
  // was created by something other than this router (app code, the browser),
  // so its distance is unmeasurable and traversals across it are not guarded.
  let currentHistoryIndex: number | null = BLOCKER_ENABLED ? readHistoryIndex(history.state) : null;
  if (!hadExistingScrollKey || (BLOCKER_ENABLED && currentHistoryIndex === null)) {
    if (!hadExistingScrollKey) currentScrollKey = generateScrollKey();
    let entryState = withScrollKeyInHistoryState(history.state, currentScrollKey);
    if (BLOCKER_ENABLED) {
      currentHistoryIndex ??= 0;
      entryState = withHistoryIndex(entryState, currentHistoryIndex);
    }
    try {
      history.replaceState(entryState, "", window.location.href);
    } catch {
      // Some embedders restrict history mutation; scroll restoration then
      // degrades to scroll-to-top, which matches the previous behavior.
    }
  }

  // The document (path + query) the router currently has rendered. Used on
  // popstate to tell a same-document fragment navigation apart from a
  // traversal that needs the route re-resolved.
  let currentDocumentPath = window.location.pathname + window.location.search;
  // Same entry as `currentDocumentPath` but fragment included, because a
  // navigation guard is told where it currently is, and `popstate` fires after
  // `window.location` has already moved on.
  let currentBrowserHref = BLOCKER_ENABLED
    ? window.location.pathname + window.location.search + window.location.hash
    : "";

  function saveScrollPosition(): void {
    scrollStore.set(currentScrollKey, { x: window.scrollX, y: window.scrollY });
  }

  window.addEventListener("pagehide", saveScrollPosition);

  /**
   * Push a new entry with a fresh scroll key and the next index.
   *
   * `tolerateFailure` is for the caller that can still do something useful
   * when an embedder restricts history mutation — the fragment scroll lands,
   * the entry just is not recorded. A navigation cannot: it would commit a
   * route the URL bar disagrees with, so the throw propagates.
   */
  function pushHistoryEntry(url: string, tolerateFailure?: boolean): void {
    const nextScrollKey = generateScrollKey();
    let entryState = withScrollKeyInHistoryState(null, nextScrollKey);
    if (BLOCKER_ENABLED) {
      currentHistoryIndex = (currentHistoryIndex ?? 0) + 1;
      entryState = withHistoryIndex(entryState, currentHistoryIndex);
    }
    try {
      history.pushState(entryState, "", url);
      currentScrollKey = nextScrollKey;
    } catch (error: unknown) {
      if (!tolerateFailure) throw error;
    }
  }

  /**
   * Entry indices the router is traversing back to after a guard refused a
   * traversal. The browser fires `popstate` for that correction too, and it is
   * not a navigation.
   *
   * Keyed by index rather than a single "skip the next one" flag: two rapid
   * back/forward presses put two popstates in the queue ahead of the
   * correction, so a positional flag was spent on whichever arrived first —
   * swallowing a real traversal and then processing the router's own
   * correction as one.
   */
  const pendingTraversalCorrections = BLOCKER_ENABLED ? new Set<number>() : null;

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
      pushHistoryEntry(url.pathname + url.search + url.hash, true);
    }
    currentDocumentPath = url.pathname + url.search;
    if (BLOCKER_ENABLED) currentBrowserHref = url.pathname + url.search + url.hash;

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

    const { Shell, Component, capabilities, componentProps, data, params, routeId, url, version } =
      routeState;
    activeRouteStateVersion = version;

    useLayoutEffect(() => {
      onRouteChange?.(capabilities);
      if (!afterCommitCallback) return;
      const callback = afterCommitCallback;
      afterCommitCallback = null;
      callback();
    }, [capabilities, version]);
    const routeElement = h(RouteComponent, { Component, componentProps });
    const componentTree = Shell
      ? h(Shell as FunctionComponent<Record<string, unknown>>, null, routeElement)
      : routeElement;

    return h(
      NavigateContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: navigateValue },
      h(
        PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
        {
          data,
          params,
          routeId,
          routes: app.routes,
          stateVersion: version,
          url,
          isCurrent: () => activeRouteStateVersion === version,
        },
        componentTree,
      ),
    );
  }

  function applyRouteState(routeState: RouteRenderState): void {
    activeRouteStateVersion = routeState.version;
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
      capabilities: match.route.capabilities ?? [],
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
      capabilities: match.route.capabilities ?? [],
      componentProps: {},
      data: undefined,
      params: match.params,
      routeId: match.route.id ?? "",
      url: currentUrl,
      version: ++routeStateVersion,
    };
  }

  async function navigate(
    to: string | UntypedRouteTarget,
    opts?: InternalNavigateOptions,
  ): Promise<void> {
    const navigationTarget =
      typeof to === "string" ? to : buildHrefUntyped(app.routes, to.route, to);

    // Before anything is aborted or superseded: a guard that runs after
    // `latestNavigationId` moves would cancel the navigation already on screen
    // in order to refuse the one replacing it. Traversals are guarded in the
    // `popstate` handler instead, which knows how far to put the entry back.
    if (
      BLOCKER_ENABLED &&
      !opts?._popstate &&
      !opts?._blockerChecked &&
      isBlocked(currentBrowserHref, navigationTarget, opts?.replace ? "replace" : "push", () => {
        void navigate(to, opts);
      })
    ) {
      return;
    }

    const navigationId = ++latestNavigationId;
    activeNavigationAbort?.abort();
    const abortController = new AbortController();
    activeNavigationAbort = abortController;
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
          : ((PREFETCH_ENABLED ? getCachedRouteState(target.requestUrl) : undefined) ??
            fetchPrachtRouteState(target.requestUrl, { signal: abortController.signal }));
      } else {
        statePromise = Promise.resolve({
          type: "data" as const,
          data: undefined,
          fontHead: { preloadLinks: [], css: "" },
        });
      }
      const routeModPromise = startRouteImport(match);
      const shellModPromise = startShellImport(match);

      // Await route state (need it to handle redirects before rendering)
      let state: { data: unknown; error?: SerializedRouteError | null } = {
        data: undefined,
        error: null,
      };
      let fontHead: FontHeadFragments | undefined =
        match.route.hasHead === false ? { preloadLinks: [], css: "" } : undefined;
      try {
        const result = await statePromise;
        if (navigationId !== latestNavigationId) return;
        if (result.type === "redirect") {
          if (result.location) {
            const hop = (opts?._redirectHop ?? 0) + 1;
            if (hop > MAX_REDIRECT_HOPS) {
              console.error(`[pracht] too many redirects: ${result.location}`);
              return;
            }
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
              await navigate(redirect.internalPath, {
                ...opts,
                _blockerChecked: true,
                _redirectHop: hop,
              });
              return;
            }

            window.location.href = target.browserUrl;
            return;
          }
          // An opaque redirect: `redirect: "manual"` hid both the status and
          // the destination, so the client cannot resolve it. Hand the URL
          // back to the browser and let it follow the 3xx as a document
          // navigation.
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
          fontHead = result.fontHead ?? { preloadLinks: [], css: "" };
        } else {
          state = {
            data: result.data,
            error: null,
          };
          if (result.fontHead) fontHead = result.fontHead;
        }
      } catch {
        if (abortController.signal.aborted || navigationId !== latestNavigationId) return;
        if (!(IS_STATIC_TARGET && (opts?._staticFallback || match.route.render === "spa"))) {
          // Network error — full page load as fallback. On a static host that
          // reload lands on the real prerendered document (or the host's 404
          // page), so it is safe there too — with two exceptions that fall
          // through and render without loader data instead:
          // - a 200.html fallback boot, where the reload would re-serve the
          //   fallback document itself and loop;
          // - a matched `render: "spa"` route, whose dynamic paths have no
          //   prerendered document or state file at all — a reload would land
          //   in-app navigation on the host's 404 page (or bounce through the
          //   fallback document) even though the client can render the route.
          window.location.href = target.browserUrl;
          return;
        }
        if (!opts?._staticFallback) {
          fontHead = { preloadLinks: [], css: "" };
        }
      }

      // The fallback document owns generic head metadata shared by every URL
      // it rewrites. A loaderless/headless SPA route takes the no-fetch branch
      // above, so preserve those document fonts outside the catch path too.
      if (opts?._staticFallback) fontHead = undefined;

      if (navigationId !== latestNavigationId) return;

      if (!opts?._popstate) {
        // Remember where the outgoing history entry was scrolled to before
        // this entry is replaced / a new one is pushed.
        saveScrollPosition();
        if (opts?.replace) {
          let entryState = withScrollKeyInHistoryState(history.state, currentScrollKey);
          if (BLOCKER_ENABLED) {
            currentHistoryIndex ??= 0;
            entryState = withHistoryIndex(entryState, currentHistoryIndex);
          }
          history.replaceState(entryState, "", target.browserUrl);
        } else {
          pushHistoryEntry(target.browserUrl);
        }
        const hashIndex = target.browserUrl.indexOf("#");
        currentDocumentPath =
          hashIndex === -1 ? target.browserUrl : target.browserUrl.slice(0, hashIndex);
        if (BLOCKER_ENABLED) currentBrowserHref = target.browserUrl;
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
        if (fontHead) applyFontHeadFragments(fontHead);
        applyRouteState(routeState);
      };
      const useViewTransition = opts?.viewTransition ?? app.viewTransitions === true;
      await commitWithOptionalViewTransition(commit, useViewTransition);
    } finally {
      settleNavigation(navigationToken);
    }
  }

  /**
   * Decide what a click on an anchor means: a navigation the browser keeps, an
   * in-page fragment commit, or a client navigation.
   */
  function handleLinkClick(e: MouseEvent): void {
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

    // Resolve relative URLs against the current document, matching native
    // anchor behavior. This also keeps `href="about"` and query-only links
    // inside a sub-path deploy base.
    const isFragmentHref = href.startsWith("#");
    let url: URL;
    try {
      url = new URL(href, window.location.href);
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
    // and force a redundant SPA fetch of the route-state JSON. Anchors the
    // rules exclude (`rel="nofollow"`, `data-pracht-speculate="off"`) have no
    // prerendered document to activate, so they stay on the SPA path.
    const targetMatch = matchResolvedRoute(app, stripBase(url.pathname) ?? url.pathname);
    if (targetMatch && supportsSpeculationRules() && !isSpeculationSuppressed(anchor)) {
      const spec = normalizeSpeculation(targetMatch.route.speculation);
      if (spec?.mode === "prerender") return;
    }

    e.preventDefault();
    const navOptions: NavigateOptions = {};
    if (anchor.hasAttribute(PRESERVE_SCROLL_ATTRIBUTE)) navOptions.preserveScroll = true;
    if (anchor.hasAttribute(VIEW_TRANSITION_ATTRIBUTE)) navOptions.viewTransition = true;
    navigate(url.pathname + url.search + url.hash, navOptions);
  }

  function handlePopstate(): void {
    const traversedToIndex = BLOCKER_ENABLED ? readHistoryIndex(history.state) : null;

    if (traversedToIndex !== null && pendingTraversalCorrections?.delete(traversedToIndex)) {
      // The router put this entry back itself. Re-adopting the index keeps the
      // cursor honest when several traversals raced the correction.
      currentHistoryIndex = traversedToIndex;
      return;
    }

    // An entry with no index was not created by this router, so how far the
    // browser moved is unknown — and a traversal whose distance cannot be
    // measured cannot be put back. Those pass unguarded rather than being
    // blocked into a history position nobody asked for.
    if (traversedToIndex !== null && currentHistoryIndex !== null) {
      const currentIndex = currentHistoryIndex;
      const delta = traversedToIndex - currentIndex;
      if (
        delta !== 0 &&
        isBlocked(currentBrowserHref, window.location.href, "pop", () => {
          history.go(delta);
        })
      ) {
        pendingTraversalCorrections?.add(currentIndex);
        history.go(-delta);
        return;
      }
    }

    // Adopted here rather than at the bottom so the same-document fragment
    // branch below, which returns early, does not leave the router pointing at
    // the index of an entry it is no longer on.
    if (BLOCKER_ENABLED) currentHistoryIndex = traversedToIndex;

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
    if (BLOCKER_ENABLED) {
      currentBrowserHref = window.location.pathname + window.location.search + window.location.hash;
    }
    navigate(window.location.pathname + window.location.search + window.location.hash, {
      _popstate: true,
    });
  }

  // Static-export SPA fallback document (200.html): the host serves it for
  // URLs with no prerendered file, so its serialized hydration state does not
  // describe the real location. Skip hydration and boot from window.location
  // once the router is registered below.
  const isStaticFallbackBoot = IS_STATIC_TARGET && options.initialState.fallback === true;

  // Static exports render 404.html once, at a synthetic path — the host then
  // serves that one file for every unknown URL. Adopt the real location so
  // useLocation() and subsequent navigation see the URL actually visited,
  // and keep the not-found page (matching the served DOM) even when the real
  // path would pattern-match a non-prerendered dynamic route.
  const isStaticNotFoundDocument =
    IS_STATIC_TARGET &&
    !isStaticFallbackBoot &&
    options.initialState.routeId === NOT_FOUND_ROUTE_ID;
  // Hydrate against the URL that produced the serialized HTML. Static
  // `404.html` adopts the visitor's real path only after hydration completes;
  // doing it before hydrate would make any location-dependent not-found tree
  // differ from its build-time DOM.
  const initialStateUrl = options.initialState.url;

  const initialTarget = resolveBrowserRouteTarget(initialStateUrl);
  const initialRequestUrl = initialTarget?.requestUrl ?? initialStateUrl;
  const initialBrowserUrl = initialTarget?.browserUrl ?? initialStateUrl;
  const initialPathname = initialTarget?.pathname ?? initialStateUrl;
  // The serialized URL produced the server/static HTML, so it must also drive
  // the first client render. Visitor-specific query parameters are published
  // after the complete hydration tree settles to keep that render identical.
  const hydrationBrowserTarget = resolveBrowserRouteTarget(
    window.location.pathname + window.location.search + window.location.hash,
  );
  // The not-found page is served at a URL that matches no route, so matching
  // cannot find it — the hydration state's reserved route id does.
  const initialMatch = isStaticFallbackBoot
    ? undefined
    : isStaticNotFoundDocument && app.notFound
      ? { route: app.notFound, params: {}, pathname: initialPathname }
      : (matchResolvedRoute(app, initialPathname) ??
        (options.initialState.routeId === NOT_FOUND_ROUTE_ID && app.notFound
          ? { route: app.notFound, params: {}, pathname: initialPathname }
          : undefined));
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
          if (!result.location) {
            // Opaque redirect — destination unreadable. Reload the document so
            // the browser follows the 3xx itself.
            window.location.href = initialBrowserUrl;
            return;
          }
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
          applyFontHeadFragments(result.fontHead ?? { preloadLinks: [], css: "" });
        } else {
          state = {
            data: result.data,
            error: null,
          };
          if (result.fontHead) applyFontHeadFragments(result.fontHead);
        }
      } catch {
        if (!IS_STATIC_TARGET) {
          window.location.href = initialBrowserUrl;
          return;
        }
        // Static export: the route-state file is missing (for example a
        // stale deploy). Reloading would re-serve this same shell document
        // and fetch the same missing file again — render without loader data
        // instead of looping.
        state = { data: undefined, error: null };
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
          onHydrationComplete(() => {
            if (!hydrationBrowserTarget || !updateRouteState) return;

            updateRouteState((currentState) => {
              // Serialized route-state URLs are browser URLs (base included),
              // matching what a client-side navigation commits. `404.html`
              // renders at a synthetic path, so it adopts the visitor's URL
              // wholesale rather than keeping its own path.
              const hydratedTarget = isStaticNotFoundDocument
                ? hydrationBrowserTarget
                : resolveBrowserRouteTarget(currentState.url);
              if (!hydratedTarget) return currentState;
              const nextRequestUrl = hydratedTarget.urlPathname + hydrationBrowserTarget.search;
              // A navigation that committed while a Suspense boundary was
              // hydrating owns the newer state. Revalidated data lives in the
              // runtime provider and survives this URL-only update.
              if (
                currentState.version !== initialRouteState.version ||
                currentState.url === nextRequestUrl
              ) {
                return currentState;
              }
              return {
                ...currentState,
                url: nextRequestUrl,
              };
            });
          });
        }
      }
    }
  }

  document.addEventListener("click", handleLinkClick);

  window.addEventListener("popstate", handlePopstate);

  window.__PRACHT_NAVIGATE__ = navigate;

  if (isStaticFallbackBoot) {
    const bootPath = window.location.pathname + window.location.search + window.location.hash;
    // Route matching is base-free; `stripBase` returns null only for a URL
    // outside the deploy base, which the fallback document cannot be serving.
    const bootMatch = matchResolvedRoute(app, stripBase(window.location.pathname) ?? "/");
    const isClientRoutableSpaMatch =
      bootMatch != null &&
      bootMatch.route.render === "spa" &&
      bootMatch.route.hydration !== "islands" &&
      bootMatch.route.hydration !== "none";
    if (isClientRoutableSpaMatch) {
      await navigate(bootPath, { replace: true, _staticFallback: true });
    } else if (app.notFound) {
      // No client-routable SPA match. In particular, a dynamic SSG pattern can
      // match a path that getStaticPaths() did not emit; rendering that route
      // without its missing build-time state would show invalid content or
      // crash. Render the app's not-found page client-side instead.
      const notFoundState = await resolveRouteState(
        { route: app.notFound, params: {}, pathname: window.location.pathname },
        { data: options.initialState.data, error: options.initialState.error ?? null },
        window.location.pathname + window.location.search,
      );
      if (notFoundState) applyRouteState(notFoundState);
    }
  }

  // Publish readiness only after a static fallback has resolved and committed
  // its real route. The fallback document starts with an empty body, so
  // marking it ready before the async route import finishes would violate the
  // public test/tooling contract below.
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

  if (PREFETCH_ENABLED) {
    const warmModules: ModuleWarmFn = (match) => {
      startRouteImport(match);
      startShellImport(match);
    };
    registerPrefetchTarget(app, warmModules);
    const { setupPrefetching } = await import("./prefetch.ts");
    setupPrefetching(app, warmModules);
  }
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

    // Same origin but outside the deploy base is somebody else's app on this
    // host. Returning null hands the link back to the browser.
    const routePathname = stripBase(url.pathname);
    if (routePathname === null) {
      return null;
    }

    return {
      browserUrl: url.pathname + url.search + url.hash,
      // Route paths carry no base; the browser and request URLs do.
      pathname: routePathname,
      requestUrl: url.pathname + url.search,
      search: url.search,
      urlPathname: url.pathname,
    };
  } catch {
    return null;
  }
}
