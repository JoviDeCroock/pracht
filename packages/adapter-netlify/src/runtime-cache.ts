import {
  getTimeRevalidateSeconds,
  isCacheableISGResponse,
  isDangerousPrerenderHeader,
  preventHeuristicCaching,
  type ResolvedRoute,
} from "@pracht/core/server";

import { normalizePathname, ROUTE_STATE_REQUEST_HEADER } from "./runtime-path.ts";
import type { NetlifyCacheOptions } from "./types.ts";

const DEFAULT_STALE_WHILE_REVALIDATE = 31_536_000;
const DEFAULT_STATIC_MAX_AGE = 31_536_000;
const ISG_CACHE_TAG = "pracht:isg";
const NETLIFY_CACHE_POLICY_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "netlify-cdn-cache-control",
] as const;

/** Cache tag for one concrete ISG pathname. */
export function netlifyRouteCacheTag(pathname: string): string {
  return `pracht:path:${encodeURIComponent(normalizePathname(pathname))}`;
}

export function resolveCacheOptions(
  options: NetlifyCacheOptions | undefined,
): Required<NetlifyCacheOptions> {
  return {
    staleWhileRevalidate: nonNegativeInteger(
      options?.staleWhileRevalidate,
      DEFAULT_STALE_WHILE_REVALIDATE,
    ),
    staticMaxAge: nonNegativeInteger(options?.staticMaxAge, DEFAULT_STATIC_MAX_AGE),
  };
}

export function applyNetlifyISGCacheHeaders(
  response: Response,
  route: ResolvedRoute,
  pathname: string,
  cache: Required<NetlifyCacheOptions>,
): Response {
  if (response.status !== 200) return response;

  let prepared = stripDangerousSharedCacheHeaders(response, pathname);
  if (!isCacheableISGResponse(prepared)) return prepared;

  const seconds = getTimeRevalidateSeconds(route.revalidate) ?? cache.staticMaxAge;
  const headers = new Headers(prepared.headers);
  if (!hasExplicitCachePolicy(headers)) {
    headers.set(
      "netlify-cdn-cache-control",
      `public, durable, max-age=${seconds}, stale-while-revalidate=${cache.staleWhileRevalidate}`,
    );
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }
  ensureNetlifyPageVary(headers);
  appendNetlifyCacheTags(headers, [ISG_CACHE_TAG, netlifyRouteCacheTag(pathname)]);
  prepared = cloneResponse(prepared, headers);
  return prepared;
}

export function applyNetlifyDynamicCacheHeaders(
  request: Request,
  response: Response,
  routeStateRequest: boolean,
  sharesStaticPageCachePolicy: boolean,
): Response {
  const prepared = preventHeuristicCaching(request, response);
  const cacheControl = prepared.headers.get("cache-control");
  if (
    prepared.headers.has("netlify-cdn-cache-control") ||
    !cacheControl ||
    !/(?:^|,)\s*public\b/i.test(cacheControl)
  ) {
    return prepared;
  }

  // A `public` browser policy alone would make Netlify's CDN store this
  // response, so anything that must not be shared has to say so in the CDN's
  // own header before it leaves the function:
  //
  // - Route-state-shaped requests (`?_data=1` or the transport header) answer
  //   with JSON for first-party fetches but fall back to a full HTML document
  //   when browser provenance is missing. Both shapes share one CDN cache key
  //   modulo `Netlify-Vary` — `query` cannot see who asked — so a cached HTML
  //   answer under `?_data=1` would poison every later client navigation's
  //   JSON fetch for the route's TTL. A cross-site `<a href="/page?_data=1">`
  //   is all it takes to plant one.
  // - A response carrying `Set-Cookie` or `Vary: Cookie`/`Authorization` was
  //   rendered from one visitor's request state. Promoting it durable — or
  //   letting the CDN store it off the browser policy — would replay that
  //   visitor's document (and any cookie) to everyone.
  if (routeStateRequest || !isCacheableISGResponse(prepared)) {
    const headers = new Headers(prepared.headers);
    headers.set("netlify-cdn-cache-control", "private");
    return cloneResponse(prepared, headers);
  }

  const headers = new Headers(prepared.headers);
  headers.set("netlify-cdn-cache-control", `${cacheControl}, durable`);
  // The response is now eligible for Netlify's shared cache. `Netlify-Vary`
  // keeps the custom route-state transport separate, while the framework's
  // standard `Vary: Accept` owns content negotiation. `query` preserves
  // Netlify's default full-query cache key.
  if (!headers.has("netlify-vary")) {
    if (sharesStaticPageCachePolicy) ensureNetlifyPageVary(headers);
    else headers.set("netlify-vary", `query,header=${ROUTE_STATE_REQUEST_HEADER}`);
  }
  return cloneResponse(prepared, headers);
}

export function hasExplicitCachePolicy(headers: Headers): boolean {
  return NETLIFY_CACHE_POLICY_HEADERS.some((name) => headers.has(name));
}

/**
 * Netlify's CDN combines standard `Vary` with `Netlify-Vary`. A cached page
 * document uses the platform header for Pracht's custom route-state transport
 * and query collapsing, while standard `Vary: Accept` keeps content-negotiated
 * Markdown separate:
 *
 * - `query=_data` — route-state transport via `?_data=1` gets its own cache
 *   key while every unrelated query parameter collapses onto the pathname
 *   entry (sanitized ISG renders never see the query anyway).
 * - `header=x-pracht-route-state-request` — client navigations request route
 *   state with this header on the page URL itself; without it the CDN would
 *   replay cached HTML to a fetch that needs JSON.
 * - `Vary: Accept` (Markdown-capable routes only) — `Accept` is not a supported
 *   `Netlify-Vary` header value, so the standard content-negotiation header
 *   emitted by the framework owns that variant.
 *
 * Route-state and Markdown responses themselves are never durable-cached, so
 * the extra variants stay cache misses that reach the function.
 */
export function ensureNetlifyPageVary(headers: Headers): void {
  if (headers.has("netlify-vary")) return;
  headers.set("netlify-vary", `query=_data,header=${ROUTE_STATE_REQUEST_HEADER}`);
}

function appendNetlifyCacheTags(headers: Headers, requiredTags: string[]): void {
  const tags = (headers.get("netlify-cache-tag") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()));
  for (const tag of requiredTags) {
    if (normalized.has(tag.toLowerCase())) continue;
    tags.push(tag);
    normalized.add(tag.toLowerCase());
  }
  headers.set("netlify-cache-tag", tags.join(","));
}

function stripDangerousSharedCacheHeaders(response: Response, pathname: string): Response {
  const dangerous = [...response.headers.keys()].filter(isDangerousPrerenderHeader);
  if (dangerous.length === 0) return response;

  const headers = new Headers(response.headers);
  for (const name of dangerous) headers.delete(name);
  console.error(
    `Stripped ${dangerous.map((name) => `"${name}"`).join(", ")} from the ISG response for ` +
      `"${pathname}" before Netlify's shared cache stored it.`,
  );
  return cloneResponse(response, headers);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}

function cloneResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
