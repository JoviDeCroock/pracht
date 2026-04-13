---
"@pracht/vite-plugin": minor
"@pracht/adapter-cloudflare": minor
---

Adapters can now contribute their own Vite plugins via a new `vitePlugins()`
hook on `PrachtAdapter`, plus an `ownsDevServer` flag that lets the adapter
take over dev-server request handling. The `@cloudflare/vite-plugin`
integration moved out of `@pracht/vite-plugin` and into
`@pracht/adapter-cloudflare`, so the vite-plugin no longer ships a Cloudflare
special case or peer-depends on `@cloudflare/vite-plugin` / `wrangler`.

`@pracht/vite-plugin` now depends on `@pracht/adapter-node` directly (the
default-adapter code path generates an import of it) and no longer lists
`@pracht/adapter-cloudflare` or `@pracht/adapter-vercel` in dependencies —
install those only when you use them.
