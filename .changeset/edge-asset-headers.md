---
"@pracht/core": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
"@pracht/cli": patch
---

Hashed scripts, stylesheets, fonts, and source maps under `/assets/` on Cloudflare and Vercel are served without the document-only security headers, and Vercel now caches them as immutable.
