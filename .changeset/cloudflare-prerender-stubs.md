---
"@pracht/cli": patch
"@pracht/adapter-cloudflare": patch
---

`pracht build` and graph commands now load apps that import any current `cloudflare:workers`, `cloudflare:workflows`, `cloudflare:pipelines`, or `cloudflare:node` export, such as `waitUntil` or `NonRetryableError`. Bindings read from `cloudflare:workers` while prerendering are named in a build warning instead of silently resolving to `undefined`.
