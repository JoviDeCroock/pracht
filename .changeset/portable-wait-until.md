---
"@pracht/core": minor
"@pracht/capabilities": minor
"@pracht/adapter-node": minor
"@pracht/adapter-cloudflare": minor
"@pracht/adapter-netlify": minor
"@pracht/adapter-vercel": minor
"@pracht/adapter-static": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/test": minor
---

Loaders, middleware, API routes, `head()`/`headers()`, and capability `run()` receive a portable `waitUntil(promise)` that keeps work running after the response on every adapter, reports a rejection instead of crashing, and is drained by Node's graceful shutdown and awaited by builds.
