import { ROUTE_STATE_CACHE_CONTROL, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";

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
