---
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Stop evaluating the adapter's server entry when reading the app graph. `pracht
dev`'s startup banner, `pracht inspect`, `pracht plan`, and `pracht verify` now
load the adapter-neutral `virtual:pracht/dev-metadata` module (which gained
`apiRoutes` and `buildTarget` exports) instead of `virtual:pracht/server`. On
Cloudflare apps using `workerExportsFrom`, loading the server entry in Vite's
Node SSR environment logged `Cannot find module 'cloudflare:workers'` on every
`pracht dev` start and swallowed the route/API banner. Metadata evaluation
errors remain intact instead of falling back to that runtime-specific entry.
