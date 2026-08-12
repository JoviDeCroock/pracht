---
title: Streaming
lead: Push live updates to the browser with first-party Server-Sent Events helpers — createEventStream on the server, useEventSource in components — and wire WebSockets per adapter.
breadcrumb: Streaming
prev:
  href: /docs/recipes/logging
  title: Logging
next:
  href: /docs/recipes/fullstack-cloudflare
  title: Full-Stack Cloudflare
---

## Server-Sent Events

For server→client streaming — live dashboards, progress updates, notification
feeds, LLM token streams — Server-Sent Events are the simplest tool that works
on **every adapter**: it is an ordinary HTTP response that never ends, so Node,
Cloudflare Workers, and Vercel all stream it without platform-specific code.
The browser side is plain `EventSource`, which even reconnects automatically.

Reach for [WebSockets](#websockets) only when the *client* also needs to push a
continuous stream of messages; for occasional client→server writes, a normal
API `POST` next to an SSE stream is simpler and works everywhere.

### The API route

`createEventStream(request, init?)` from `@pracht/core/server` returns the
`Response` to hand back plus `send` and `close`:

```ts [src/api/live.ts]
import type { BaseRouteArgs } from "@pracht/core";
import { createEventStream } from "@pracht/core/server";

export function GET({ request }: BaseRouteArgs) {
  const stream = createEventStream(request, { keepAlive: 15 });

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const delivered = stream.send({
      data: { now: new Date().toISOString(), tick },
      event: "tick",
      id: String(tick),
    });
    // send() returns false once the client is gone — stop producing.
    if (!delivered) clearInterval(timer);
  }, 1000);

  return stream.response;
}
```

What the helper takes care of:

- **Wire format.** `send({ data, event?, id?, retry? })` serializes the SSE
  frame: strings pass through (multi-line values become one `data:` line per
  line), everything else is `JSON.stringify`ed. `event:`/`id:` values
  containing CR/LF are rejected — a newline there would let untrusted input
  forge extra protocol lines.
- **Disconnect cleanup.** Both disconnect paths a runtime can deliver are
  wired: `request.signal` aborting (Cloudflare, Vercel Edge) and the response
  stream being cancelled (the Node adapter tears the pipe down when the client
  hangs up). Either way `send()` starts returning `false` and the keep-alive
  timer is cleared — use the return value as your producer's stop condition.
- **Headers.** `Content-Type: text/event-stream`, plus
  `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` so
  shared caches never store the stream and compressing/buffering proxies
  (nginx and friends) leave the framing alone.
- **Proxy idle timeouts.** `keepAlive: 15` emits a comment line
  (`:keep-alive`) every 15 seconds so load balancers with idle timeouts keep
  the connection open.

Try it with curl (`-N` disables curl's own buffering):

```bash
curl -N http://localhost:5173/api/live
# event: tick
# id: 1
# data: {"now":"2026-08-12T09:30:00.000Z","tick":1}
#
# event: tick
# id: 2
# ...
```

One thing the helper deliberately does not do: apply backpressure. Messages
sent faster than the client reads them buffer in the stream. SSE frames are
small, so this is fine for event feeds; throttle in your producer if you are
pushing serious volume.

### The component

`useEventSource(url, options?)` wraps `EventSource`: it connects on mount,
disconnects on unmount (which is exactly when the server's `send()` starts
returning `false`), tracks connection state, and optionally JSON-parses
payloads. Pass `null` as the URL to stay disconnected — handy for gating the
subscription on user state.

```tsx [src/routes/live.tsx]
import { useEventSource } from "@pracht/core";

export function Component() {
  const { data, status } = useEventSource<{ now: string; tick: number }>("/api/live", {
    event: "tick", // listen for the named event; omit for unnamed messages
    json: true,
  });

  return (
    <section>
      <p>Connection: {status /* "connecting" | "open" | "closed" */}</p>
      <p>{data ? `tick ${data.tick} at ${data.now}` : "waiting for the first event"}</p>
    </section>
  );
}
```

The browser reconnects dropped SSE connections on its own (tune the delay by
sending `retry:`), so `status` may bounce between `"open"` and `"connecting"`
on a flaky network without any code on your part. During SSR the hook renders
`{ status: "connecting" }` and never connects — the subscription is
client-only by nature.

The working example lives in the repo's `examples/basic` app: route `/live`,
endpoint `src/api/live.ts`.

## WebSockets

A WebSocket upgrade is request handling with a platform-specific ending, so
where it lives depends on the adapter. The framework ships one shared helper —
`isUpgradeRequest(request)` from `@pracht/core/server` — and a same-origin
guard: browsers do not apply CORS to WebSocket, so pracht blocks cross-origin
upgrade requests by default (`api.requireSameOrigin`).

### Cloudflare

The Cloudflare adapter serves upgrades **through** pracht routing: an API
route returns the `101` handshake response and the runtime passes it through
untouched (identity-preserved — the `webSocket` handle survives). For
connection state, forward to a Durable Object:

```ts [src/api/ws.ts]
import type { BaseRouteArgs } from "@pracht/core";
import { isUpgradeRequest } from "@pracht/core/server";

interface Env {
  CHAT_ROOM: DurableObjectNamespace;
}

export function GET({ request, context }: BaseRouteArgs<{ env: Env }>) {
  if (!isUpgradeRequest(request)) {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const room = context.env.CHAT_ROOM.get(context.env.CHAT_ROOM.idFromName("lobby"));
  return room.fetch(request);
}
```

```ts [src/server/chat-room.ts]
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  override fetch(_request: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server); // hibernation-friendly
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    for (const peer of this.ctx.getWebSockets()) peer.send(String(message));
  }
}
```

Upgrades work in `pracht dev` the same way they do in production. See the
[Adapters reference](/docs/adapters) for the wrangler wiring.

### Node

Node's `http.Server` delivers upgrade requests to its `upgrade` event, never
to the request handler, so a handshake structurally cannot reach pracht.
Attach a WebSocket server (e.g. [`ws`](https://github.com/websockets/ws))
alongside pracht instead. The Node adapter's `configureServerFrom` option
hands you the underlying `http.Server` before `listen()`:

```ts [vite.config.ts]
nodeAdapter({
  configureServerFrom: "/src/server/websockets.ts",
});
```

```ts [src/server/websockets.ts]
import type { Server } from "node:http";
import { WebSocketServer } from "ws";

export function configureServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // Browsers do not apply CORS to WebSocket, and this path never reaches
    // pracht's own same-origin guard — check Origin yourself or any page on
    // the web can open an authenticated socket (cross-site hijacking).
    const origin = req.headers.origin;
    if (origin !== process.env.PRACHT_ORIGIN) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    ws.on("message", (message) => ws.send(String(message)));
  });
}
```

`configureServer` may be async; it runs when the generated entry is the
process entrypoint. If you import `handler` and build the server yourself,
attach the listener the same way on your own `createServer(handler)`.

### Vercel

The Vercel adapter cannot serve WebSocket upgrades (serverless and edge
functions terminate them upstream). Use [Server-Sent Events](#server-sent-events)
for server→client streaming, or a hosted realtime service for bidirectional
messaging.
