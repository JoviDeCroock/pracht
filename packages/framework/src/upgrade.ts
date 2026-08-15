/**
 * True when `request` is a WebSocket upgrade handshake (`Upgrade: websocket`).
 *
 * Use it at the top of an API route that serves WebSockets to reject plain
 * HTTP requests with `426 Upgrade Required` instead of hanging them:
 *
 * ```ts
 * export function GET({ request }: BaseRouteArgs) {
 *   if (!isUpgradeRequest(request)) {
 *     return new Response("Expected a WebSocket upgrade", { status: 426 });
 *   }
 *   // Cloudflare: new WebSocketPair() / forward to a Durable Object.
 * }
 * ```
 *
 * The `Upgrade` header is a comma-separated protocol list, so this matches
 * `websocket` as a token (case-insensitively) rather than comparing the raw
 * header value. Note the framework's same-origin guard for upgrades
 * (`api.requireSameOrigin`, on by default) runs before any API route —
 * browsers do not apply CORS to WebSocket, so keep that guard on unless you
 * check `Origin` yourself.
 */
export function isUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get("upgrade");
  if (!upgrade) return false;
  return upgrade.split(",").some((protocol) => protocol.trim().toLowerCase() === "websocket");
}
