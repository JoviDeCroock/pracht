---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/adapter-static": patch
"@pracht/adapter-vercel": patch
"@pracht/i18n": patch
"@pracht/query": patch
"@pracht/session": patch
"@pracht/test": patch
"@pracht/vite-plugin": patch
"create-pracht": patch
---

`@pracht/vite-plugin`, the adapters, `@pracht/session`, `@pracht/i18n`, `@pracht/query`, and `@pracht/test` now take `@pracht/core` as a peer dependency, so upgrading core no longer installs a second copy under them.
