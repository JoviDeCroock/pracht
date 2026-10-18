---
"@pracht/adapter-cloudflare": patch
---

With `cloudflareAdapter({ cache: true })`, a webhook whose edge purge is rejected or fails reports the path in `failed` with reason `edge_purge_failed`, instead of `revalidated`.
