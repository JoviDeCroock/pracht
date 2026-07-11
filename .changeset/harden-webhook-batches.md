---
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
---

Limit webhook revalidation requests to 64 paths and keep malformed Node or
Cloudflare manifest entries isolated to their individual batch result.
