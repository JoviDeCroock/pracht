---
"@pracht/core": minor
"@pracht/adapter-node": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-netlify": patch
---

Regenerated ISG pages now keep the same document headers on every adapter, and Cloudflare now strips credential-shaped headers from them like Node, Vercel and Netlify do.
