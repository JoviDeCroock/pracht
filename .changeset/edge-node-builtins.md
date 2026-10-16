---
"@pracht/vite-plugin": minor
"@pracht/adapter-cloudflare": minor
---

Cloudflare builds may import `node:async_hooks` when the Wrangler config enables `nodejs_als` or `nodejs_compat`, instead of failing the edge runtime check.
