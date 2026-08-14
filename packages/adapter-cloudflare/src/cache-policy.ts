/** Request-time Cloudflare Workers Caching policy for time-revalidated ISG routes. */

import {
  getTimeRevalidateSeconds,
  isCacheableISGResponse,
  matchAppRoute,
} from "@pracht/core/server";
import type { PrachtApp, ResolvedPrachtApp, ResolvedRoute } from "@pracht/core/server";

import type { CloudflareWorkersCacheOption, CloudflareWorkersCacheOptions } from "./cache-types.ts";

const DEFAULT_STALE_WHILE_REVALIDATE = 31_536_000;

/** Tag attached to every ISG page cached through Workers Caching. */
export const ISG_CACHE_TAG = "pracht:isg";

/**
 * Cache tag attached to every cached page of a route. Pass a route's `id`
 * (or its `path` for routes without an id) to target it from `purgeCache()`.
 */
export function routeCacheTag(routeIdOrPath: string): string {
  return `pracht:route:${routeIdOrPath}`;
}

export function resolveWorkersCacheOptions(
  option: CloudflareWorkersCacheOption | undefined,
): Required<CloudflareWorkersCacheOptions> | null {
  if (!option) return null;
  const options = option === true ? {} : option;
  return {
    staleWhileRevalidate: coercePositiveIntegerSeconds(
      options.staleWhileRevalidate,
      DEFAULT_STALE_WHILE_REVALIDATE,
    ),
  };
}

/**
 * Match a request against the app's ISG routes. Returns the route when the
 * request should be rendered fresh and handed to Workers Caching instead of
 * being served from the prerendered static snapshot: a GET/HEAD document
 * request (not the route-state JSON transport) for an ISG route with a
 * time-revalidation policy.
 */
export function findCacheableIsgRoute(
  app: PrachtApp | ResolvedPrachtApp,
  request: Request,
): ResolvedRoute | null {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return null;
  }

  const match = matchAppRoute(app, url.pathname);
  if (!match) return null;

  const route = match.route;
  if (route.render !== "isg") return null;
  // Webhook-only routes are not edge-cached: a time window at the edge would
  // delay webhook revalidation until the TTL expires. They stay on the
  // worker-managed Cache API path, where regeneration takes effect instantly.
  const seconds = getTimeRevalidateSeconds(route.revalidate);
  if (seconds === null || seconds <= 0) return null;

  return route;
}

/**
 * Stamp an ISG response with the headers Workers Caching reads:
 *
 * - `cloudflare-cdn-cache-control` — `max-age` carries the route's
 *   revalidate window for the edge and `stale-while-revalidate` lets expired
 *   pages keep being served while the Worker re-renders in the background.
 *   The edge directives live in this header (highest precedence; Cloudflare
 *   consumes and strips it) rather than `Cache-Control`, because RFC 9111
 *   §4.2.4 forbids serving stale when `must-revalidate` or `s-maxage` is
 *   present — putting them in `Cache-Control` would disable
 *   stale-while-revalidate entirely.
 * - `Cache-Control: public, max-age=0, must-revalidate` — browsers keep
 *   revalidating, matching the Node adapter's ISG responses.
 * - `Cache-Tag` — `pracht:isg` plus the route tag, for `purgeCache()`.
 * Markdown-capable routes already carry `Vary: Accept` from the core runtime
 * on both their HTML and markdown responses. Routes without a `markdown`
 * export deliberately do not vary so verbatim Accept values cannot fragment
 * their edge cache.
 *
 * A user-set `Cache-Control` or `cloudflare-cdn-cache-control` (via a
 * route/shell `headers()` export or middleware) takes full precedence:
 * pracht adds nothing, so routes can opt out or tune their own policy.
 * Responses that are not a cacheable page (non-200, `Set-Cookie`,
 * `Cache-Control: private` / `no-store`, or `Vary: Cookie` /
 * `Authorization` / `*`) pass through untouched.
 */
export function applyWorkersCacheHeaders(
  response: Response,
  route: ResolvedRoute,
  options: Required<CloudflareWorkersCacheOptions>,
): Response {
  if (response.status !== 200) return response;
  if (response.headers.has("cache-control")) return response;
  if (response.headers.has("cloudflare-cdn-cache-control")) return response;
  if (!isCacheableISGResponse(response)) return response;

  const seconds = getTimeRevalidateSeconds(route.revalidate) ?? 0;
  if (seconds <= 0) return response;

  const headers = new Headers(response.headers);
  headers.set(
    "cloudflare-cdn-cache-control",
    `max-age=${seconds}, stale-while-revalidate=${options.staleWhileRevalidate}`,
  );
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  headers.set("cache-tag", `${ISG_CACHE_TAG},${routeCacheTag(route.id ?? route.path)}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Header directives must be non-negative integers — a negative, NaN, or
 * fractional value would produce a malformed `cloudflare-cdn-cache-control`
 * header that Cloudflare ignores. Coerce to a positive integer or fall back
 * to the default.
 */
function coercePositiveIntegerSeconds(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const seconds = Math.floor(value);
  return seconds > 0 ? seconds : fallback;
}
