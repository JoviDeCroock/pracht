import type { BaseRouteArgs } from "@pracht/core";

/**
 * WebSocket upgrades are served by API routes. The handshake itself is
 * produced by the `ChatRoom` Durable Object (see `src/workers/chat-room.ts`),
 * which owns the socket for as long as it stays open; this handler only routes
 * the request to the right room and hands the `101` back unchanged.
 *
 * Pracht passes protocol-switch responses through its response pipeline
 * untouched, so nothing here needs to opt out of security headers or caching.
 *
 * Note that pracht blocks cross-origin upgrade requests by default — browsers
 * do not apply CORS to WebSocket, so without that check any page on the web
 * could open an authenticated socket to this room. Set
 * `api: { requireSameOrigin: false }` in `defineApp` only if you intend this
 * endpoint to be reachable from other origins, and authenticate it yourself.
 */
export async function GET({ context, request, url }: BaseRouteArgs): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const { CHAT_ROOM } = context.env as { CHAT_ROOM: DurableObjectNamespace };
  const room = url.searchParams.get("room") ?? "lobby";
  return CHAT_ROOM.get(CHAT_ROOM.idFromName(room)).fetch(request);
}
