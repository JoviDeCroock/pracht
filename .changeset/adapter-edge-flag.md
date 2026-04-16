---
"@pracht/vite-plugin": minor
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
---

Add an `edge` flag to `PrachtAdapter`. Adapters that target edge runtimes (where `node_modules` cannot be resolved at runtime) set `edge: true`, and the Vite plugin reads it to enable `ssr.noExternal` for SSR builds. The built-in Cloudflare and Vercel adapters opt in; custom edge adapters can do the same instead of the plugin hard-coding adapter ids.
