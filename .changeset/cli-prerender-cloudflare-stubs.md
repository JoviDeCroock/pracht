---
"@pracht/cli": patch
---

`pracht build` now stubs `cloudflare:*` platform modules (via Node module
hooks) while importing the built server bundle for SSG prerendering. Edge
server bundles keep these imports external because they only exist inside
workerd, so any app whose worker graph imports `cloudflare:workers` or
`cloudflare:email` previously failed the prerender pass with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`.
