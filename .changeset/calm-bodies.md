---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/adapter-vercel": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Normalize null-body responses across development and production adapters so an explicit nonzero `Content-Length` cannot leave clients waiting for bytes.
