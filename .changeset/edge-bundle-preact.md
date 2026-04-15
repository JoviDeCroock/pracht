---
"@pracht/vite-plugin": patch
---

Bundle all dependencies into the server entry for edge adapters (Vercel, Cloudflare) by setting `ssr.noExternal: true` during SSR builds, fixing "unsupported modules" errors on Vercel Edge Functions.
