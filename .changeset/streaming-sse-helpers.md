---
"@pracht/core": minor
---

Add first-party streaming helpers: Server-Sent Events and WebSocket ergonomics.

`createEventStream(request, init?)` (exported from `@pracht/core` and
`@pracht/core/server`) builds an SSE response for API route handlers and
returns `{ response, send, close, closed }`. It handles the wire format
(`send({ data, event?, id?, retry? })` — strings pass through with multi-line
splitting, other values are JSON-serialized, CR/LF injection through
`event`/`id` fields is rejected), sets `Content-Type: text/event-stream` with
`Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` so caches
and transforming proxies leave the stream alone, and offers a
`keepAlive: seconds` heartbeat that emits comment lines to defeat proxy idle
timeouts. Cleanup is wired to both disconnect paths a runtime can deliver —
`request.signal` aborting (workerd, edge) and the response stream being
cancelled (Node) — after which `send()` returns `false` (the producer's stop
condition) and the heartbeat timer is cleared. Built on web `ReadableStream`,
so it works identically on the Node, Cloudflare, and Vercel adapters.
`serializeEventStreamMessage()` is exported for code that manages its own
stream.

`useEventSource(url, options?)` (from `@pracht/core` / `@pracht/core/browser`)
is the client half: a small hook wrapping `EventSource` with auto-cleanup on
unmount, named-event selection, optional JSON parsing, connection status
(`connecting` / `open` / `closed`), and `lastEventId`. Pass `null` to stay
disconnected.

`isUpgradeRequest(request)` (from `@pracht/core` and `@pracht/core/server`)
detects a WebSocket handshake (token-wise, case-insensitive `Upgrade` header
match) so API routes can answer plain HTTP requests with `426`.
