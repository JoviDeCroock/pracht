import { ROUTE_STATE_CACHE_CONTROL, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";

export function applyHeaders(headers: Headers, init: HeadersInit): void {
  new Headers(init).forEach((value, key) => {
    headers.set(key, value);
  });
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
  options?: { isRouteStateRequest: boolean },
): Headers {
  applyDefaultSecurityHeaders(headers);
  if (options) {
    appendVaryHeader(headers, ROUTE_STATE_REQUEST_HEADER);
    if (options.isRouteStateRequest && !headers.has("cache-control")) {
      headers.set("cache-control", ROUTE_STATE_CACHE_CONTROL);
    }
  }
  return headers;
}

export function withDefaultSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function withRouteResponseHeaders(
  response: Response,
  options: { isRouteStateRequest: boolean },
): Response {
  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers, options);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
