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

Loaders, middleware, API routes, `head()`/`headers()`, and capability `run()` now receive `waitUntil(promise)`, which keeps work running after the response on every adapter. Migration: code that builds these args by hand must pass `waitUntil` (for example `waitUntil: () => {}`).
