---
"@pracht/vite-plugin": minor
"@pracht/adapter-cloudflare": patch
---

Make `pracht()` fully synchronous by requiring adapter `vitePlugins()` hooks to return plugin arrays synchronously. The Cloudflare adapter now imports `@cloudflare/vite-plugin` statically and returns its workerd integration without an async dynamic import.
