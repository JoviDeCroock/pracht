---
"@pracht/adapter-node": minor
---

Add a `configureServerFrom` entry option to `nodeAdapter()`. It names a
Vite-resolvable module whose `configureServer(server)` export the generated
entry calls (and awaits) with the underlying `node:http` server after
`createServer()` and before `listen()`. This is the supported hook for
attaching a WebSocket server to the `upgrade` event — which Node routes past
the request handler entirely — without giving up the generated entry. See
docs/ADAPTERS.md § WebSockets for the full recipe including the Origin check.
