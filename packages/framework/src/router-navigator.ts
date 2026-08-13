import { buildHrefUntyped } from "./route-href.ts";
import { matchResolvedRoute } from "./route-pattern.ts";
import {
  beginLoadingNavigation,
  createNavigationLocation,
  settleNavigation,
} from "./navigation-state.ts";
import { getCachedRouteState } from "./prefetch-cache.ts";
import { commitWithOptionalViewTransition, resolveBrowserRouteTarget } from "./router-browser.ts";
import type { RouterHistoryController } from "./router-history.ts";
import type { ClientRouteRenderer } from "./router-renderer.ts";
import {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  routeNeedsServerFetch,
} from "./runtime-client-fetch.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type {
  NavigateOptions,
  ResolvedPrachtApp,
  RouteId,
  RouteTarget,
  UntypedRouteTarget,
} from "./types.ts";

export interface InternalNavigateOptions extends NavigateOptions {
  _popstate?: boolean;
  _reloadRouteState?: boolean;
}

export interface InternalNavigateFn {
  (to: string, options?: InternalNavigateOptions): Promise<void>;
  <TRoute extends RouteId>(
    to: RouteTarget<TRoute>,
    options?: InternalNavigateOptions,
  ): Promise<void>;
}

export interface ClientNavigatorOptions {
  app: ResolvedPrachtApp;
  history: RouterHistoryController;
  renderer: ClientRouteRenderer;
}

interface RedirectTarget {
  documentUrl?: string;
  externalUrl?: string;
  internalPath?: string;
  isCurrentLocation: boolean;
  unsafe?: boolean;
}

/** Create the cancellable route-state fetch and render transaction. */
export function createClientNavigator(options: ClientNavigatorOptions): InternalNavigateFn {
  const { app, history, renderer } = options;
  let latestNavigationId = 0;
  let activeNavigationAbort: AbortController | null = null;

  function resolveRedirectTarget(location: string): RedirectTarget {
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
      return { externalUrl: targetUrl.toString(), isCurrentLocation: false };
    }
    if (targetUrl.hash) {
      return { documentUrl: targetUrl.toString(), isCurrentLocation };
    }
    return { internalPath, isCurrentLocation };
  }

  async function navigate(
    to: string | UntypedRouteTarget,
    navigationOptions?: InternalNavigateOptions,
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
    if (!match || match.route.hydration === "islands" || match.route.hydration === "none") {
      window.location.href = target.browserUrl;
      return;
    }

    const navigationToken = beginLoadingNavigation(createNavigationLocation(target.browserUrl));
    try {
      let statePromise: Promise<RouteStateResult>;
      if (routeNeedsServerFetch(match.route)) {
        statePromise = navigationOptions?._reloadRouteState
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

      let state: { data: unknown; error?: SerializedRouteError | null } = {
        data: undefined,
        error: null,
      };
      try {
        const result = await statePromise;
        if (navigationId !== latestNavigationId) return;

        if (result.type === "redirect") {
          if (!result.location) {
            window.location.href = target.browserUrl;
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
          if (redirect.isCurrentLocation) return;
          if (redirect.documentUrl) {
            window.location.href = redirect.documentUrl;
            return;
          }
          if (redirect.internalPath) {
            await navigate(redirect.internalPath, navigationOptions);
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
          state = { data: undefined, error: result.error };
        } else {
          state = { data: result.data, error: null };
        }
      } catch {
        if (abortController.signal.aborted || navigationId !== latestNavigationId) return;
        window.location.href = target.browserUrl;
        return;
      }

      if (navigationId !== latestNavigationId) return;
      if (!navigationOptions?._popstate) {
        history.commitRouteNavigation(target.browserUrl, {
          replace: navigationOptions?.replace,
        });
      }

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
          history.restoreOrResetScroll(
            {
              preserveScroll: navigationOptions?.preserveScroll,
              traversal: navigationOptions?._popstate,
            },
            target.browserUrl,
          ),
        );
        renderer.applyRouteState(routeState);
      };
      const useViewTransition = navigationOptions?.viewTransition ?? app.viewTransitions === true;
      await commitWithOptionalViewTransition(commit, useViewTransition);
    } finally {
      settleNavigation(navigationToken);
    }
  }

  return navigate as InternalNavigateFn;
}
