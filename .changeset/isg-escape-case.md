---
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-cloudflare": patch
---

An ISG page requested or revalidated with lower-case percent-escapes (`/posts/caf%c3%a9`) now uses the same snapshot as its upper-case URL.
