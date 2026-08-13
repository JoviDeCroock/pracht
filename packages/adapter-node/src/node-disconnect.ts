/**
 * Node error codes that mean "the client went away mid-response", not "the
 * server broke". `http.createServer()` does not await the handler's promise,
 * so letting one of these reject would surface as an unhandled rejection and
 * (on Node >= 15) terminate the process — a client pressing Escape would take
 * the server down with it.
 */
const CLIENT_DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * Whether `error` is a client disconnect rather than a server-side failure.
 *
 * Walks the `cause` chain because a transport wraps the underlying failure
 * (undici reports a peer reset as `TypeError: terminated` with
 * `cause.code === "ECONNRESET"`). The walk is iterative and cycle-guarded: a
 * self-referential or mutually-referential `cause` is legal JavaScript, and
 * recursing on it would throw `RangeError` from inside the handler's own
 * catch block — turning the crash this function exists to prevent back into an
 * unhandled rejection.
 */
export function isClientDisconnectError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CLIENT_DISCONNECT_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
