import {
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
} from "@pracht/capabilities";

import { ROUTE_STATE_CACHE_CONTROL, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import type { LoaderCache } from "./types.ts";

const HEADER_CRLF_RE = /[\r\n]/;

/**
 * Reject header values containing CR/LF. Some runtimes (Node `undici`
 * Headers) throw on their own, but Web-runtime fetch implementations
 * vary, and a user-supplied `headers()` value is never trusted input.
 * Keeping the check here means response-splitting can't slip through on
 * any adapter.
 */
export function assertSafeHeaderValue(name: string, value: string): void {
  if (HEADER_CRLF_RE.test(value)) {
    throw new Error(`Refused to set header "${name}": value contains CR or LF`);
  }
}

export function applyHeaders(headers: Headers, init: HeadersInit): void {
  // Validate before handing to the platform's Headers constructor: Node
  // throws a generic "invalid header value" that's easy to mis-handle,
  // and Web-runtime fetch implementations differ on CR/LF enforcement.
  // A single consistent error message makes the framework guarantee
  // portable across adapters.
  for (const [key, value] of iterateHeaderInit(init)) {
    assertSafeHeaderValue(key, value);
  }
  new Headers(init).forEach((value, key) => {
    headers.set(key, value);
  });
}

function* iterateHeaderInit(init: HeadersInit): Iterable<[string, string]> {
  if (init instanceof Headers) {
    for (const entry of init.entries()) yield entry;
    return;
  }
  if (Array.isArray(init)) {
    for (const entry of init) {
      if (entry && entry.length >= 2) {
        yield [entry[0], entry[1]];
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(init as Record<string, string>)) {
    yield [key, value];
  }
}

export function applyDefaultSecurityHeaders(headers: Headers): Headers {
  if (!headers.has("permissions-policy")) {
    headers.set(
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  }

  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }

  if (!headers.has("x-content-type-options")) {
    headers.set("x-content-type-options", "nosniff");
  }

  if (!headers.has("x-frame-options")) {
    headers.set("x-frame-options", "SAMEORIGIN");
  }

  return headers;
}

export function applySecurityAndRouteHeaders(
  headers: Headers,
  options?: { isRouteStateRequest: boolean; loaderCache?: LoaderCache },
): Headers {
  applyDefaultSecurityHeaders(headers);
  if (options) {
    appendVaryHeader(headers, ROUTE_STATE_REQUEST_HEADER);
    if (options.isRouteStateRequest && !headers.has("cache-control")) {
      headers.set("cache-control", getRouteStateCacheControl(options.loaderCache));
    }
  }
  return headers;
}

/**
 * True for responses that switch protocols instead of carrying a body —
 * chiefly the `101 Switching Protocols` handshake a WebSocket upgrade
 * returns.
 *
 * Such a response must be handed back to the runtime as the *same object*
 * the handler produced. Copying it via `new Response(body, init)` fails
 * twice over: the Response constructor rejects any status below 200, and
 * the `webSocket` property (Cloudflare Workers' handle on the server end of
 * the socket) is not part of `ResponseInit`, so it is silently dropped even
 * where the status is tolerated. Header post-processing is skipped for the
 * same reason — and costs nothing, because a handshake has no body for a
 * sniffing or framing policy to protect.
 *
 * Detection reads `webSocket` explicitly rather than using `in`, because
 * workerd defines a `webSocket` getter on `Response.prototype` — `in` is
 * true there for every response.
 */
export function isProtocolSwitchResponse(response: Response): boolean {
  return response.status < 200 || (response as { webSocket?: unknown }).webSocket != null;
}

/**
 * Headers that already express a CDN caching policy. Any of them means the
 * author has decided; pracht adds nothing.
 */
const CDN_CACHE_CONTROL_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "netlify-cdn-cache-control",
  "surrogate-control",
  "vercel-cdn-cache-control",
] as const;

/**
 * Stamp `Cache-Control: private, no-cache` on GET/HEAD responses that carry no
 * caching policy of their own.
 *
 * A shared cache in front of the app — Cloudflare's Workers Caching, a CDN, a
 * reverse proxy — may apply RFC 9111 heuristic freshness to a `200` that has no
 * `Cache-Control`, and `Cookie` is not part of its cache key. Without this, an
 * authenticated SSR page or an API `GET` can be stored and replayed to another
 * user. The hazard is a property of "shared cache in front of an origin", not
 * of any one platform, so every adapter applies the same default: leaving it to
 * Cloudflare alone meant an app hardened there silently lost the protection
 * when it moved to Node or Vercel.
 *
 * Anything that set its own policy passes through untouched: ISG responses,
 * route-state JSON, static assets, and user `headers()` exports or middleware.
 */
export function preventHeuristicCaching(request: Request, response: Response): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  // A WebSocket handshake carries no cacheable body, and the fallback branch
  // below would destroy it: reconstructing the response drops the `webSocket`
  // handle and the constructor rejects status 101 outright.
  if (isProtocolSwitchResponse(response)) return response;
  // Any CDN-targeted policy counts as "the author decided". Honouring only
  // Cloudflare's proprietary header would stamp `private, no-cache` on a
  // response whose author deliberately set the vendor-neutral
  // `CDN-Cache-Control` (RFC 9213) and left `Cache-Control` off on purpose.
  for (const header of CDN_CACHE_CONTROL_HEADERS) {
    if (response.headers.has(header)) return response;
  }

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

export function withDefaultSecurityHeaders(response: Response): Response {
  if (isProtocolSwitchResponse(response)) return response;

  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Keep enhanced Pracht form redirects inside the original same-origin fetch.
 * Both API-backed and capability-backed forms use this protocol. The client
 * performs the browser navigation after reading the target, so the destination
 * is not loaded twice and cross-origin login pages are never fetched through
 * CORS.
 */
export function withEnhancedCapabilityFormRedirect(response: Response, request: Request): Response {
  if (request.headers.get(CAPABILITY_FORM_REQUEST_HEADER) !== "1") {
    return response;
  }
  if (response.status < 300 || response.status >= 400) {
    return response;
  }
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("location");
  // Fetch resolves a relative Location against the response URL. Preserve
  // those semantics when moving the target into the enhanced-form handshake
  // instead of letting the client resolve it against the current page.
  let redirectTarget = location;
  try {
    redirectTarget = new URL(location, request.url).toString();
  } catch {
    // The client applies the shared safe-navigation check before using the
    // target, so keep an unparseable value for it to reject explicitly.
  }
  headers.set(CAPABILITY_FORM_REDIRECT_HEADER, redirectTarget);
  headers.set("cache-control", "no-store");
  appendVaryHeader(headers, CAPABILITY_FORM_REQUEST_HEADER);
  return new Response(null, { status: 204, headers });
}

export function withRouteResponseHeaders(
  response: Response,
  options: { isRouteStateRequest: boolean; loaderCache?: LoaderCache },
): Response {
  if (isProtocolSwitchResponse(response)) return response;

  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers, options);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getRouteStateCacheControl(loaderCache: LoaderCache | undefined): string {
  if (loaderCache === undefined || loaderCache === false || loaderCache === 0) {
    return ROUTE_STATE_CACHE_CONTROL;
  }
  return `private, max-age=${loaderCache}`;
}

export function appendVaryHeader(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }

  const values = current
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes("*") || values.includes(value.toLowerCase())) {
    return;
  }

  headers.set("vary", `${current}, ${value}`);
}

/** Headers recorded while prerendering, indexed by route pathname. */
export type HeadersManifest = Record<string, Record<string, string>>;

export function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const routeHeaders = getManifestHeaders(headersManifest, pathname);
  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

export function getManifestHeaders(
  headersManifest: HeadersManifest,
  pathname: string,
): Record<string, string> | undefined {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";

  return (
    headersManifest[pathname] ??
    headersManifest[withoutSlash] ??
    headersManifest[withoutIndex] ??
    undefined
  );
}
