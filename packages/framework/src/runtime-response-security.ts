/** Apply conservative browser security defaults without overriding app policy. */
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

/**
 * True for responses that switch protocols instead of carrying a body —
 * chiefly the `101 Switching Protocols` handshake a WebSocket upgrade
 * returns. These must retain object identity because platform handles such as
 * Cloudflare's `webSocket` property are not part of `ResponseInit`.
 * Detection reads the value explicitly because workerd defines a getter on
 * `Response.prototype`, making an `in` check true for every response.
 */
export function isProtocolSwitchResponse(response: Response): boolean {
  return response.status < 200 || (response as { webSocket?: unknown }).webSocket != null;
}

/** Clone an ordinary response with framework security defaults applied. */
export function withDefaultSecurityHeaders(response: Response): Response {
  if (isProtocolSwitchResponse(response)) return response;

  const headers = new Headers(response.headers);
  applyDefaultSecurityHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
