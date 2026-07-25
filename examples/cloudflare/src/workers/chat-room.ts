import { DurableObject } from "cloudflare:workers";

/**
 * A chat room whose members are WebSocket connections.
 *
 * Durable Objects are the reason WebSockets work on Cloudflare at all: a
 * Worker isolate is per-request, so something has to outlive the request and
 * own the socket. The room is reachable through pracht's API route in
 * `src/api/ws.ts`, which forwards the upgrade request here and returns the
 * handshake response untouched.
 *
 * Uses the hibernation API (`ctx.acceptWebSocket`) rather than
 * `server.accept()`, so an idle room is evicted from memory without dropping
 * its connections and is re-instantiated when the next message arrives.
 */
export class ChatRoom extends DurableObject<unknown> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    // This response has to reach the client as *this object*. Copying it —
    // `new Response(response.body, { status, headers })` — both trips the
    // Response constructor's 200..599 status check and silently drops the
    // `webSocket` handle, leaving a socket nobody is holding.
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : "<binary>";
    for (const peer of this.ctx.getWebSockets()) {
      peer.send(JSON.stringify({ from: peer === ws ? "you" : "peer", text }));
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // 1005 ("no status received") is not a valid code to send back.
    ws.close(code === 1005 ? 1000 : code, reason);
  }
}
