/**
 * Cloudflare Workers Cache (Workers Caching) support.
 *
 * Workers Caching sits in front of the Worker: Cloudflare stores responses
 * whose caching headers mark them cacheable and serves repeat requests
 * without invoking the Worker at all. Pracht maps ISG routes onto it — the
 * `revalidate` window becomes the edge `max-age` (carried in
 * `cloudflare-cdn-cache-control`, which Cloudflare consumes and strips), and
 * stale pages are served instantly while the Worker re-renders in the
 * background (`stale-while-revalidate`). Cached pages are tagged so loaders,
 * API routes, and webhooks can invalidate them with `purgeCache()`.
 *
 * Everything in this module must stay safe to bundle into the worker —
 * no `vite` or Node imports.
 */
import {
  getTimeRevalidateSeconds,
  isCacheableISGResponse,
  matchAppRoute,
} from "@pracht/core/server";
import type { PrachtApp, ResolvedPrachtApp, ResolvedRoute } from "@pracht/core/server";

export interface CloudflareWorkersCacheOptions {
  /**
   * Seconds a stale ISG page may keep being served while the Worker
   * re-renders it in the background. Defaults to one year, which gives
   * classic ISG semantics: after the revalidate window a visitor always
   * gets the cached page instantly and the refresh happens off the
   * critical path.
   */
  staleWhileRevalidate?: number;
}

export type CloudflareWorkersCacheOption = boolean | CloudflareWorkersCacheOptions;

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
 * - `Vary: Accept` — Markdown-for-Agents negotiation returns a different
 *   body for `Accept: text/markdown`, so cached variants must be keyed by
 *   the Accept header.
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
  appendVary(headers, "Accept");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Keep Workers Caching's heuristic freshness away from responses pracht did
 * not deliberately mark cacheable. When `"cache": { "enabled": true }` is
 * set in wrangler config, Cloudflare applies RFC 9111 heuristic caching to
 * 200 responses that carry no `Cache-Control` header (~2 hours), and
 * `Cookie` is not part of the cache key — SSR pages (including
 * authenticated ones) and API GET responses would be edge-cached
 * cross-user. Stamping `Cache-Control: private, no-cache` on GET/HEAD
 * responses that lack a caching policy makes heuristic caching impossible.
 *
 * Responses that already carry a `Cache-Control` (ISG responses stamped by
 * `applyWorkersCacheHeaders`, user-set policies via `headers()` exports or
 * middleware) pass through untouched.
 */
export function preventHeuristicCaching(request: Request, response: Response): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  // 101 (WebSocket upgrade) responses cannot be reconstructed and are never cached.
  if (response.status === 101) return response;
  if (response.headers.has("cache-control")) return response;
  if (response.headers.has("cloudflare-cdn-cache-control")) return response;

  try {
    response.headers.set("cache-control", "private, no-cache");
    return response;
  } catch {
    // Immutable headers (e.g. a response passed through from `fetch`).
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-cache");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const values = current.split(",").map((part) => part.trim().toLowerCase());
  if (values.includes("*") || values.includes(value.toLowerCase())) return;
  headers.set("vary", `${current}, ${value}`);
}

export interface PurgeCacheOptions {
  /** Purge cached responses tagged with any of these `Cache-Tag` values. */
  tags?: string[];
  /** Purge cached responses whose request path starts with any of these prefixes. */
  pathPrefixes?: string[];
  /** Purge every cached response for this Worker entrypoint. Exclusive with the other fields. */
  purgeEverything?: boolean;
}

interface CloudflareWorkersCacheModule {
  cache?: { purge(options: PurgeCacheOptions): Promise<unknown> };
}

const CLOUDFLARE_WORKERS_MODULE = "cloudflare:workers";

/**
 * Invalidate Workers Caching entries from anywhere in the app — loaders,
 * API routes, middleware, queue handlers. This is how webhook-based ISG
 * revalidation works on Cloudflare:
 *
 * ```ts
 * // src/api/revalidate.ts
 * import { purgeCache, routeCacheTag } from "@pracht/adapter-cloudflare/cache";
 *
 * export async function POST() {
 *   await purgeCache({ tags: [routeCacheTag("pricing")] });
 *   return Response.json({ revalidated: true });
 * }
 * ```
 *
 * Wraps `cache.purge()` from `cloudflare:workers`, which only exists inside
 * the Workers runtime. Outside it (Node, tests, prerendering) this throws a
 * descriptive error instead of a resolution failure.
 */
export async function purgeCache(options: PurgeCacheOptions): Promise<unknown> {
  if (!options.purgeEverything && !options.tags?.length && !options.pathPrefixes?.length) {
    throw new Error("purgeCache() expects `tags`, `pathPrefixes`, or `purgeEverything: true`.");
  }
  if (options.purgeEverything && (options.tags?.length || options.pathPrefixes?.length)) {
    throw new Error(
      "purgeCache() with `purgeEverything: true` cannot be combined with `tags` or `pathPrefixes`.",
    );
  }

  let workers: CloudflareWorkersCacheModule;
  try {
    // Computed specifier: keeps TypeScript from trying to resolve the
    // workers-only module and keeps bundlers from inlining it; workerd
    // resolves its built-in modules at runtime.
    workers = (await import(
      /* @vite-ignore */ CLOUDFLARE_WORKERS_MODULE
    )) as CloudflareWorkersCacheModule;
  } catch {
    throw new Error(
      "purgeCache() is only available on the Cloudflare Workers runtime — `cloudflare:workers` could not be imported.",
    );
  }

  if (typeof workers.cache?.purge !== "function") {
    throw new Error(
      "purgeCache() requires the Workers Caching runtime API (`cache.purge` from `cloudflare:workers`). " +
        'Enable it with `"cache": { "enabled": true }` in wrangler.jsonc and make sure wrangler is up to date.',
    );
  }

  return workers.cache.purge(options);
}
