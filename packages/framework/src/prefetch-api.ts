/**
 * Imperative prefetch surface shared by the lazy prefetch listeners
 * (`prefetch.ts`), the client router, and userland code via the public
 * `prefetch()` export. Kept separate from `prefetch.ts` so importing the
 * public API does not pull the document-level listener setup into the
 * critical hydration path — every module imported here is already part of
 * the core client bundle.
 */

import { buildHref, matchResolvedRoute } from "./route-matching.ts";
import {
  cacheRouteState,
  EMPTY_ROUTE_STATE_PROMISE,
  getCachedRouteState,
  removeCachedRouteState,
} from "./prefetch-cache.ts";
import { fetchPrachtRouteState, routeNeedsServerFetch } from "./runtime-client-fetch.ts";
import type { RouteStateResult } from "./runtime-client-fetch.ts";
import type {
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteId,
  RouteMatch,
  RouteTarget,
} from "./types.ts";

export type ModuleWarmFn = (match: RouteMatch) => void;

interface PrefetchTarget {
  app: ResolvedPrachtApp;
  warmModules?: ModuleWarmFn;
}

let activePrefetchTarget: PrefetchTarget | null = null;

/**
 * Called by the client router during initialization so prefetching can match
 * URLs against the resolved app and warm route/shell module chunks.
 */
export function registerPrefetchTarget(app: ResolvedPrachtApp, warmModules?: ModuleWarmFn): void {
  activePrefetchTarget = { app, warmModules };
}

export function getPrefetchTarget(): { app: ResolvedPrachtApp; warmModules?: ModuleWarmFn } | null {
  return activePrefetchTarget;
}

/**
 * Fetch (or reuse) the route-state JSON for `url` and store it in the shared
 * bounded prefetch cache so a subsequent client navigation can consume it
 * without a second network request. Rejected fetches are evicted from the
 * cache so a transient network error does not poison later navigations.
 */
export function prefetchRouteState(url: string, route?: ResolvedRoute): Promise<RouteStateResult> {
  if (route && !routeNeedsServerFetch(route)) return EMPTY_ROUTE_STATE_PROMISE;

  const cached = getCachedRouteState(url);
  if (cached) return cached;

  const promise = fetchPrachtRouteState(url);
  cacheRouteState(url, promise);
  promise.catch(() => removeCachedRouteState(url, promise));
  return promise;
}

export interface PrefetchFn {
  (to: string): Promise<void>;
  <TRoute extends RouteId>(to: RouteTarget<TRoute>): Promise<void>;
}

/**
 * Imperatively prefetch a route: warms the route/shell module chunks and
 * caches the route-state JSON in the shared prefetch cache. Accepts an href
 * string or a typed route target (`{ route, params, search }`).
 *
 * Available once the client router has initialized; a no-op during SSR,
 * before hydration, and for URLs that do not match a client route.
 */
export const prefetch: PrefetchFn = async (to: string | RouteTarget): Promise<void> => {
  if (typeof window === "undefined") return;
  const target = activePrefetchTarget;
  if (!target) return;

  let href: string;
  try {
    href = typeof to === "string" ? to : buildHref(target.app.routes, to.route, to as never);
  } catch {
    return;
  }

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) return;

  const match = matchResolvedRoute(target.app, url.pathname);
  if (!match) return;

  target.warmModules?.(match);
  await prefetchRouteState(url.pathname + url.search, match.route).catch(() => {});
};
