---
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
---

Reduce the default browser bootstrap by adding lean core client/manifest entries,
resolving browser route imports through a client-safe core entry, and loading
prefetch listener setup after the router initializes. Adapters now point
generated server entries at `@pracht/core/server` so edge worker builds do not
resolve server imports through the browser condition.
