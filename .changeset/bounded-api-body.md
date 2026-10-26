---
"@pracht/core": patch
"@pracht/capabilities": patch
---

`defineApi()` body validation and the ISG revalidation webhook now reject request bodies over 1 MiB with a 413 on every adapter, including Cloudflare, Netlify, and Vercel Edge. Raise the limit for one handler with `defineApi({ maxBodySize })`.
