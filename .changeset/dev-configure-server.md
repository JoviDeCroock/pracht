---
"@pracht/vite-plugin": patch
"@pracht/adapter-node": patch
---

`pracht dev` now calls the Node adapter's `configureServerFrom` hook with its own HTTP server, so WebSocket servers attached there work in development too.
