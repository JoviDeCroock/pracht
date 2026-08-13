import { ROUTE_STATE_CACHE_CONTROL, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import { appendVaryHeader } from "./runtime-header-values.ts";
import {
  applyDefaultSecurityHeaders,
  isProtocolSwitchResponse,
} from "./runtime-response-security.ts";
import type { LoaderCache } from "./types.ts";

/** Apply security defaults and route-state cache negotiation policy. */
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

/** Clone an ordinary response with route-state and security headers applied. */
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
