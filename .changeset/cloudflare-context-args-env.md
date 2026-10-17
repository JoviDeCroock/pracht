---
"@pracht/adapter-cloudflare": patch
---

`CloudflareContextArgs` and `createPrachtHandler()` type `env` with the bindings `wrangler types` generated into `Cloudflare.Env`, and keep their previous untyped `env` when an app has not generated them.
