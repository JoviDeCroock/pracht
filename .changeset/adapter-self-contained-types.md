---
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-static": patch
---

Adapter factories keep their `PrachtAdapter` return type under strict installs such as Yarn PnP or pnpm's global virtual store, where it previously resolved to `any`.
