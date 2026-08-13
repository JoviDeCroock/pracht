import {
  applySecurityAndRouteHeaders,
  appendVaryHeader,
  withRouteResponseHeaders,
} from "./runtime-headers.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { LoaderCache } from "./types.ts";

export function jsonErrorResponse(
  routeError: SerializedRouteError,
  options: { isRouteStateRequest: boolean },
): Response {
  const headers = applySecurityAndRouteHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
    options.isRouteStateRequest ? { isRouteStateRequest: true } : undefined,
  );
  return new Response(JSON.stringify({ error: routeError }), {
    status: routeError.status,
    headers,
  });
}

export function jsonRedirectResponse(
  location: string,
  options: { headers?: HeadersInit; isRouteStateRequest: boolean },
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  const response = new Response(JSON.stringify({ redirect: location }), {
    status: 200,
    headers,
  });
  return withRouteResponseHeaders(response, { isRouteStateRequest: options.isRouteStateRequest });
}

export function normalizePageResponse(
  response: Response,
  options: { isRouteStateRequest: boolean; loaderCache?: LoaderCache; markdown?: boolean },
): Response {
  if (options.isRouteStateRequest && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      return jsonRedirectResponse(location, {
        headers: response.headers,
        isRouteStateRequest: true,
      });
    }
  }

  const normalized = withRouteResponseHeaders(response, {
    isRouteStateRequest: options.isRouteStateRequest,
    loaderCache: response.ok ? options.loaderCache : undefined,
  });
  if (options.markdown === true && !options.isRouteStateRequest) {
    appendVaryHeader(normalized.headers, "Accept");
  }
  return normalized;
}
