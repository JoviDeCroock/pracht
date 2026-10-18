---
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-static": patch
---

Each adapter now exports the `PrachtAdapter` type its factory returns, so that return type no longer resolves to `any` under strict installs such as Yarn PnP or pnpm's global virtual store.
