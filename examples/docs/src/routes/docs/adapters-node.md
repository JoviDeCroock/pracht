---
title: Node.js
lead: Run pracht as a Node.js HTTP server with `@pracht/adapter-node`, and configure its origin, body limit, compression, graceful shutdown, and WebSockets.
---

The adapter runs pracht as a Node.js HTTP server that serves static files and ISG pages. The generated `dist/server/server.js` boots it and listens on `PORT`, or `3000`.

| Option | Default | Effect |
| --- | --- | --- |
| `canonicalOrigin` | none | Public origin for `request.url`; without it, the server warns that the URL comes from the `Host` header |
| `maxBodySize` | 1 MiB | Largest request body accepted |
| `basePathStripped` | `false` | Set when a proxy removes Vite's `base` (see [Sub-path deploys](/docs/deployment#sub-path-deploys)) |
| `compression` | `true` | Brotli or gzip from `Accept-Encoding` |
| `earlyHints` | `false` | Send a `103 Early Hints` response (see [Performance](/docs/performance#early-hints)) |
| `port` | `3000` | Port when `PORT` is unset |
| `shutdownTimeoutMs`, `keepAliveTimeoutMs`, `headersTimeoutMs` | `10000`, Node's defaults | See [Graceful shutdown](#graceful-shutdown) |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](/docs/adapters#context-factory)) |
| `configureServerFrom` | none | Module exporting `configureServer(server)` (see [WebSockets](#websockets)) |

## Origin, proxy, and body-size options

Pin the public origin so `request.url` never depends on the `Host` header:

```ts [vite.config.ts]
nodeAdapter({
  canonicalOrigin: "https://app.example.com",
  maxBodySize: 10 * 1024 * 1024,
});
```

Behind a trusted proxy that overwrites `Forwarded` or `X-Forwarded-*`, a custom entry can pass `trustProxy: true` to `createNodeRequestHandler()` instead; never on a directly reachable server.

A custom `node:http` server can reuse this handling from `@pracht/adapter-node/bridge`: `createWebRequest(req, res, { maxBodySize, trustProxy, canonicalOrigin })` resolves to a `Request` (its `signal` aborts on disconnect) or to the 413 or 400 `Response` to send, and `writeWebResponse(res, response)` streams the answer.

## Response compression

Responses are compressed with brotli or gzip, and streamed responses such as SSE still arrive incrementally. Already-encoded responses, `Cache-Control: no-transform`, range requests, binary media, and bodies under 1 KiB are sent as-is. If a proxy or CDN in front of the server already compresses, turn it off:

```ts [vite.config.ts]
nodeAdapter({ compression: false });
```

## ISG on several instances

Each server keeps ISG pages in its own `dist/client`, and `POST /__pracht/revalidate` reaches one replica only, so serve ISG routes from a single instance.

## Graceful shutdown

On `SIGTERM` or `SIGINT`, the generated server stops accepting connections, ends SSE streams cleanly, lets in-flight requests and [`waitUntil()`](/docs/data-loading#waituntil) work finish, then exits. Open WebSockets hold it until the limit; a second signal exits at once. Keep the limit below your platform's kill grace period:

```ts [vite.config.ts]
nodeAdapter({
  shutdownTimeoutMs: 8_000, // default 10_000
  keepAliveTimeoutMs: 65_000, // above your load balancer's idle timeout; Node's default is 5_000
  headersTimeoutMs: 66_000, // time to receive request headers; Node's default is 60_000
});
```

Custom servers built on `createNodeRequestHandler()` call `await handler.closeEventStreams(timeoutMs)` then `await handler.drain(timeoutMs)` after `server.close()`.

## WebSockets

Upgrade requests never reach pracht on Node. Attach a WebSocket server in a module that exports `configureServer(server)` and point `configureServerFrom` at it; the generated entry calls it before `listen()`, and `pracht dev` calls it too:

```ts [vite.config.ts]
nodeAdapter({ configureServerFrom: "/src/server/websockets.ts" });
```

```ts [src/server/websockets.ts]
import type { Server } from "node:http";
import { WebSocketServer } from "ws";

export function configureServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // This bypasses pracht, so check the Origin header yourself.
    if (req.headers.origin !== process.env.PRACHT_ORIGIN) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
```

The generated entry also exports `handler` and starts a server only when run as the process entrypoint, so `createServer(handler)` in your own entry works too.
