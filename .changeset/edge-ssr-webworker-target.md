---
"@pracht/vite-plugin": patch
---

Edge adapters now build the server bundle with `ssr.target: "webworker"` and
externalize `cloudflare:*` platform modules. Without the webworker target, SSR
builds of apps with CommonJS dependencies emit Node-flavored interop
(`createRequire(import.meta.url)`) that workerd rejects at startup, and
`cloudflare:workers`/`cloudflare:email` imports failed to resolve at build
time instead of remaining runtime imports.
