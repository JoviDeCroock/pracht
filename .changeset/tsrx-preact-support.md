---
"@pracht/vite-plugin": minor
---

Recognise `.tsrx` (TSRX/Ripple-flavoured Preact) modules in route and shell discovery. Users bring their own `@tsrx/vite-plugin-preact` and register it alongside `pracht()` in the Vite `plugins` array; pracht adds `.tsrx` to its route/shell globs and to the server-only export-stripping pass (via the directory check) so discovery, SSR, SSG, and client hydration all work without further configuration. `.tsrx` globs are emitted without the `?pracht-client` query suffix so the upstream plugin matches them by extension.
