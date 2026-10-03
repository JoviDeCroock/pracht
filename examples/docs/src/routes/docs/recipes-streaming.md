---
title: Server-Sent Events & WebSockets
lead: Push live updates to the browser with first-party Server-Sent Events helpers — createEventStream on the server, useEventSource in components — and wire WebSockets per adapter.
breadcrumb: SSE & WebSockets
prev:
  href: /docs/recipes/logging
  title: Logging
next:
  href: /docs/recipes/fullstack-cloudflare
  title: Full-Stack Cloudflare
---

> [!NOTE]
> This page covers streaming data to a rendered page. For streaming HTML and deferred Suspense boundaries, see [Streaming SSR](/docs/data-loading#streaming-the-document).

## Server-Sent Events

For server→client streaming — live dashboards, progress updates, notification
feeds, LLM token streams — Server-Sent Events work on **every adapter**
without platform-specific code: the response is ordinary HTTP that never ends.
The browser side is plain `EventSource`, which reconnects automatically.

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
  frame: strings pass through, everything else is `JSON.stringify`ed.
- **Disconnect cleanup.** When the client disconnects, on any adapter, `send()`
  starts returning `false`. Use that as your producer's stop condition.
- **Headers.** `Content-Type: text/event-stream`, plus
  `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` so caches
  and buffering proxies (nginx and friends) leave the stream alone.
- **Proxy idle timeouts.** `keepAlive: 15` emits a `:keep-alive` comment every
  15 seconds so load balancers with idle timeouts keep the connection open.

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

The helper applies no backpressure: messages sent faster than the client
reads them buffer without bound. That is fine for event feeds. A high-volume
producer should watch `stream.desiredSize` (remaining queue capacity, `null`
once closed) and pause or drop messages while it is zero or negative:

<!-- snippet: partial -->
```ts
const size = stream.desiredSize;
if (size === null) break; // stream closed — stop producing
if (size <= 0) continue; // consumer stalled — drop this frame
stream.send({ data: frame });
```

Two more things worth knowing before you ship an SSE endpoint:

- **Producer lifetime is yours.** The handler returns `stream.response`
  immediately, and wrapping middleware finishes then too while the stream stays
  open. Stop your producer when `send()` returns `false` (or on
  `stream.closed`), not when middleware finishes. For anything long-lived, rely
  on `request`, not the handler's `signal` argument: that signal is a
  request-phase timeout.
- **Resuming after reconnects.** The browser replays the last `id:` it saw in
  a `Last-Event-ID` request header when it reconnects. Send meaningful ids
  and read the header to resume instead of restarting:

  ```ts
  const lastEventId = request.headers.get("last-event-id");
  // Replay everything after lastEventId, then continue live.
  ```

### The component

`useEventSource(url, options?)` wraps `EventSource`: it connects on mount,
disconnects on unmount, tracks connection state, and optionally JSON-parses
payloads. Pass `null` as the URL to stay disconnected and clear the last
payload, for example until the user is signed in.

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

The browser reconnects dropped connections itself (tune the delay by sending
`retry:`), so `status` may bounce between `"open"` and `"connecting"`. During
SSR the hook renders `{ status: "connecting" }` and never connects. Changing
`url` or the options starts a fresh subscription, resetting `data` and
`lastEventId` to `undefined`.

Each `useEventSource` call opens its own connection. Over HTTP/1.1, browsers
allow about 6 connections per origin, shared with every other request, so a
few SSE subscriptions can starve the page. Lift a shared subscription into a
parent (context or props), and serve production traffic over HTTP/2 or 3.

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
untouched. For connection state, forward to a Durable Object:

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

`configureServer` may be async. It runs when the generated entry is the
process entrypoint, and on every `pracht dev` start or restart, where Vite's
own HMR handshakes never reach your `upgrade` listener. If you import `handler` and build the server yourself,
attach the listener the same way on your own `createServer(handler)`.

### Vercel

The Vercel adapter cannot serve WebSocket upgrades (serverless and edge
functions terminate them upstream). Use [Server-Sent Events](#server-sent-events)
for server→client streaming, or a hosted realtime service for bidirectional
messaging.
