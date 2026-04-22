---
"@pracht/vite-plugin": minor
---

Add opt-in support for `.tsrx` (TSRX/Ripple-flavoured Preact) route and shell modules. Pass `tsrx: true` to `pracht()` (or an options object forwarded to the underlying plugin) to enable; the plugin will load `@tsrx/vite-plugin-preact` (a new optional peer dependency) and register it with the right enforcement order. `.tsrx` files are added to the route/shell glob and to the client-only export-stripping pass, and a wrapper around the upstream plugin handles pracht's `?pracht-client` query suffix so the same compilation runs for the client variant of route modules.
