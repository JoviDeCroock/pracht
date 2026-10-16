---
"@pracht/adapter-cloudflare": patch
---

`CloudflareContextArgs` types `env` with the bindings `wrangler types` generated into `Cloudflare.Env`, and stays `Record<string, unknown>` when an app has not generated them.
