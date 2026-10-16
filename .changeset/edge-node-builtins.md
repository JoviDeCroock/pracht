---
"@pracht/vite-plugin": minor
"@pracht/adapter-cloudflare": minor
---

Cloudflare builds may import any Node.js builtin when the Wrangler config enables `nodejs_compat`, and `node:async_hooks` under `nodejs_als`, instead of failing the edge runtime check.
