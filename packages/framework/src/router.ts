import { buildHrefUntyped, matchResolvedRoute } from "./route-matching.ts";
import {
  decodeFragmentId,
  findFragmentTarget,
  focusFragmentTarget,
  scrollToFragmentTarget,
} from "./fragment-navigation.ts";
import { installHydrationMismatchWarning } from "./hydration-mismatch.ts";
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
  RouteTarget,
  UntypedRouteTarget,
} from "./types.ts";
import {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  routeNeedsServerFetch,
} from "./runtime-client-fetch.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { PrachtHydrationState } from "./runtime-context.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";
import {
  commitWithOptionalViewTransition,
  dispatchHashChange,
  resolveBrowserRouteTarget,
} from "./router-browser.ts";
import type { NavigateFn } from "./router-navigation.ts";
import { createClientRouteRenderer, type RouterModuleMap } from "./router-renderer.ts";

export { useNavigate } from "./router-navigation.ts";
export type { NavigateFn } from "./router-navigation.ts";

declare global {
  interface Window {
    __PRACHT_NAVIGATE__?: InternalNavigateFn;
    __PRACHT_ROUTER_READY__?: boolean;
  }
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

export interface InitClientRouterOptions {
  app: ResolvedPrachtApp;
  routeModules: RouterModuleMap;
  shellModules: RouterModuleMap;
  initialState: PrachtHydrationState;
  root: HTMLElement;
  findModuleKey: (modules: RouterModuleMap, file: string) => string | null;
}

export async function initClientRouter(options: InitClientRouterOptions): Promise<void> {
  const { app, routeModules, shellModules, root, findModuleKey } = options;

  if (import.meta.env?.DEV) {
    installHydrationMismatchWarning();
  }

  let latestNavigationId = 0;
  let activeNavigationAbort: AbortController | null = null;

  const renderer = createClientRouteRenderer({
    app,
    routeModules,
    shellModules,
    root,
    findModuleKey,
    navigate,
  });

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
    to: string | UntypedRouteTarget,
    opts?: InternalNavigateOptions,
  ): Promise<void> {
    const navigationId = ++latestNavigationId;
    activeNavigationAbort?.abort();
    const abortController = new AbortController();
    activeNavigationAbort = abortController;

    const navigationTarget =
      typeof to === "string" ? to : buildHrefUntyped(app.routes, to.route, to);
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
      const routeModPromise = renderer.startRouteImport(match);
      const shellModPromise = renderer.startShellImport(match);

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
      const routeState = await renderer.resolveRouteState(
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
        renderer.afterCommit(() => restoreOrResetScroll(opts, target.browserUrl));
        renderer.applyRouteState(routeState);
      };
      const useViewTransition = opts?.viewTransition ?? app.viewTransitions === true;
      await commitWithOptionalViewTransition(commit, useViewTransition);
    } finally {
      settleNavigation(navigationToken);
    }
  }

  // The serialized URL produced the server/static HTML, so it must also drive
  // the first client render. Visitor-specific query parameters are published
  // after the complete hydration tree settles to keep that render identical.
  const initialTarget = resolveBrowserRouteTarget(options.initialState.url);
  const initialRequestUrl = initialTarget?.requestUrl ?? options.initialState.url;
  const initialBrowserUrl = initialTarget?.browserUrl ?? options.initialState.url;
  const initialPathname = initialTarget?.pathname ?? options.initialState.url;
  const hydrationBrowserTarget = resolveBrowserRouteTarget(
    window.location.pathname + window.location.search + window.location.hash,
  );
  // The not-found page is served at a URL that matches no route, so matching
  // cannot find it — the hydration state's reserved route id does.
  const initialMatch =
    matchResolvedRoute(app, initialPathname) ??
    (options.initialState.routeId === NOT_FOUND_ROUTE_ID && app.notFound
      ? { route: app.notFound, params: {}, pathname: initialPathname }
      : undefined);
  if (initialMatch) {
    const initialShellPromise =
      initialMatch.route.render === "spa" && options.initialState.pending
        ? renderer.startShellImport(initialMatch)
        : null;
    let state = {
      data: options.initialState.data,
      error: options.initialState.error ?? null,
    };

    if (initialMatch.route.render === "spa" && options.initialState.pending) {
      // Use query parameter URL to match the <link rel="preload"> tag from SSR
      const dataPromise = fetchPrachtRouteState(initialRequestUrl, { useDataParam: true });

      const pendingState = await renderer.resolveSpaPendingState(
        initialMatch,
        initialRequestUrl,
        initialShellPromise,
      );
      if (pendingState) {
        renderer.mountRouteState(pendingState, "hydrate");
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

      const resolvedState = await renderer.resolveRouteState(
        initialMatch,
        state,
        initialRequestUrl,
        undefined,
        initialShellPromise,
      );
      if (resolvedState) {
        renderer.applyRouteState(resolvedState);
      }
    } else {
      const initialRouteState = await renderer.resolveRouteState(
        initialMatch,
        state,
        initialRequestUrl,
        undefined,
        initialShellPromise,
      );
      if (initialRouteState) {
        if (initialMatch.route.render === "spa") {
          renderer.mountRouteState(initialRouteState, "render");
        } else {
          markHydrating();
          renderer.mountRouteState(initialRouteState, "hydrate");
          onHydrationComplete(() => {
            if (!hydrationBrowserTarget) return;
            renderer.syncHydratedUrl(initialRouteState, hydrationBrowserTarget.search);
          });
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

  const warmModules: ModuleWarmFn = renderer.warmModules;
  registerPrefetchTarget(app, warmModules);
  void import("./prefetch.ts").then(({ setupPrefetching }) => {
    setupPrefetching(app, warmModules);
  });
}
