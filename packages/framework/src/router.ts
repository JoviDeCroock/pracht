import { buildHrefUntyped, matchResolvedRoute } from "./route-matching.ts";
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
import { NOT_FOUND_ROUTE_ID } from "./runtime-constants.ts";
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
import { commitWithOptionalViewTransition, resolveBrowserRouteTarget } from "./router-browser.ts";
import { createRouterHistoryController } from "./router-history.ts";
import { installRouterLinkInterceptor } from "./router-links.ts";
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
  const historyController = createRouterHistoryController();

  const renderer = createClientRouteRenderer({
    app,
    routeModules,
    shellModules,
    root,
    findModuleKey,
    navigate,
  });

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
        historyController.commitRouteNavigation(target.browserUrl, { replace: opts?.replace });
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
        renderer.afterCommit(() =>
          historyController.restoreOrResetScroll(
            { preserveScroll: opts?.preserveScroll, traversal: opts?._popstate },
            target.browserUrl,
          ),
        );
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

  installRouterLinkInterceptor({
    app,
    history: historyController,
    navigate: (url, navigationOptions) => {
      void navigate(url, navigationOptions);
    },
  });

  historyController.installPopstateHandler((url) => {
    void navigate(url, { _popstate: true });
  });

  window.__PRACHT_NAVIGATE__ = navigate;
  window.__PRACHT_ROUTER_READY__ = true;
  // Public hydration marker for test tooling: server-rendered pages look
  // interactive before the client router takes over, so tests (Playwright,
  // etc.) should wait for `html[data-pracht-hydrated]` before driving forms —
  // interacting earlier triggers native form submits instead of JS handlers.
  document.documentElement.setAttribute("data-pracht-hydrated", "true");

  historyController.restoreInitialScroll();

  const warmModules: ModuleWarmFn = renderer.warmModules;
  registerPrefetchTarget(app, warmModules);
  void import("./prefetch.ts").then(({ setupPrefetching }) => {
    setupPrefetching(app, warmModules);
  });
}
