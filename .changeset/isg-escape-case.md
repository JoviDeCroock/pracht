---
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
---

An ISG page requested, revalidated, or declared in `routes.ts` with lower-case percent-escapes (`/posts/caf%c3%a9`) now uses the same snapshot as its upper-case URL.
