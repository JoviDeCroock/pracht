---
title: Server-Sent Events and WebSockets
lead: Push live updates with `createEventStream` on the server and `useEventSource` in components, and wire WebSockets per adapter.
---

This recipe pushes live updates from the server to a rendered page. For streaming HTML and deferred Suspense boundaries, see [Streaming SSR](/docs/data-loading#streaming-the-document).

| Need | Use |
| --- | --- |
| Server pushes to the client (dashboards, progress, notifications, LLM tokens) | [Server-sent events](#server-sent-events), on every adapter |
| Occasional client writes alongside a server stream | SSE plus a normal API `POST` |
| A continuous stream of client messages | [WebSockets](#websockets), wired per adapter |

## Server-sent events

SSE is an ordinary HTTP response that never ends, so it needs no platform-specific code. The browser reconnects `EventSource` on its own.

### 1. Return an event stream from an API route

`createEventStream(request, init?)` from `@pracht/core/server` returns the `Response` to hand back, plus `send` and `close`:

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

Run it with curl (`-N` disables curl's own buffering) and you see one frame per second:

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

What the helper handles:

| Concern | Behaviour |
| --- | --- |
| Wire format | `send({ data, event?, id?, retry? })` writes the SSE frame; strings pass through, other values are JSON-encoded |
| Disconnects | Once the client disconnects, on any adapter, `send()` returns `false` and `stream.closed` is `true` |
| Headers | `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, and `X-Accel-Buffering: no`, so caches and buffering proxies leave the stream alone |
| Idle timeouts | `keepAlive: 15` sends a `:keep-alive` comment every 15 seconds so load balancers keep the connection open |

The handler returns `stream.response` immediately, and wrapping middleware finishes then too, while the stream stays open. Stop producing when `send()` returns `false` or `stream.closed` is `true`, not on the handler's `signal` argument, which is a request-phase timeout.

### 2. Subscribe in a component

`useEventSource(url, options?)` connects on mount, disconnects on unmount, tracks connection state, and can JSON-parse payloads:

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

The page shows "Connection: open" and the tick counter climbing once a second.

- During SSR the hook returns `{ status: "connecting" }` and never connects.
- The browser reconnects dropped connections itself (send `retry:` to tune the delay), so `status` can move between `"open"` and `"connecting"`.
- Pass `null` as the URL to stay disconnected and clear the last payload, for example until the user signs in.
- Changing `url` or the options starts a fresh subscription and resets `data` and `lastEventId` to `undefined`.

The repository's `examples/basic` app has this working at route `/live`, endpoint `src/api/live.ts`.

### Resume after a reconnect

On reconnect, the browser sends the last `id:` it saw in a `Last-Event-ID` header. Send meaningful ids and read the header to resume instead of restarting:

<!-- snippet: partial -->
```ts
const lastEventId = request.headers.get("last-event-id");
// Replay everything after lastEventId, then continue live.
```

### Handle slow consumers

The helper applies no backpressure: messages sent faster than the client reads them buffer without bound. For a high-volume producer, check `stream.desiredSize` (remaining queue capacity, `null` once closed) and pause or drop messages while it is zero or negative:

<!-- snippet: partial -->
```ts
const size = stream.desiredSize;
if (size === null) break; // stream closed — stop producing
if (size <= 0) continue; // consumer stalled — drop this frame
stream.send({ data: frame });
```

### Share connections

Each `useEventSource` call opens its own connection, and over HTTP/1.1 browsers allow about 6 per origin, shared with every other request. Lift a shared subscription into a parent (context or props), and serve production traffic over HTTP/2 or HTTP/3.

## WebSockets

Where a WebSocket upgrade is handled depends on the adapter. `isUpgradeRequest(request)` from `@pracht/core/server` detects one. Browsers do not apply CORS to WebSockets, so pracht rejects cross-origin upgrade requests that reach its routing (`api.requireSameOrigin`, default `true`).

### Cloudflare

An API route returns the `101` handshake response and the runtime passes it through. Forward to a Durable Object to hold connection state:

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

Upgrades work the same in `pracht dev` as in production. See [Adapters](/docs/adapters) for the wrangler wiring.

### Node

Node's `http.Server` delivers upgrade requests to its `upgrade` event, never to the request handler, so they cannot reach pracht. Attach a WebSocket server such as [`ws`](https://github.com/websockets/ws) alongside it. The Node adapter's `configureServerFrom` option hands you the `http.Server` before `listen()`:

<!-- snippet: partial -->
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

`configureServer` may be async. It runs when the generated entry is the process entrypoint and on every `pracht dev` start; Vite's HMR handshakes never reach your listener. If you build the server yourself from `handler`, attach the listener to your own `createServer(handler)`.

### Vercel

Vercel functions cannot serve WebSocket upgrades. Use [server-sent events](#server-sent-events) for server-to-client streaming, or a hosted realtime service for bidirectional messaging.
