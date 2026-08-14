import { isProtocolSwitchResponse } from "./runtime-response-security.ts";

/** Headers that already express a CDN caching decision. */
const CDN_CACHE_CONTROL_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "netlify-cdn-cache-control",
  "surrogate-control",
  "vercel-cdn-cache-control",
] as const;

/**
 * Stamp `private, no-cache` on GET/HEAD responses that carry no origin or CDN
 * caching policy, preventing shared caches from applying heuristic freshness
 * to personalized responses. Explicit application, platform, or RFC 9213 CDN
 * cache policy always wins. Immutable responses are reconstructed only when
 * necessary; protocol-switch responses retain their original identity.
 */
export function preventHeuristicCaching(request: Request, response: Response): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  if (isProtocolSwitchResponse(response)) return response;
  for (const header of CDN_CACHE_CONTROL_HEADERS) {
    if (response.headers.has(header)) return response;
  }

  try {
    response.headers.set("cache-control", "private, no-cache");
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-cache");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
