---
"@pracht/adapter-cloudflare": patch
---

On Cloudflare, a webhook-revalidated ISG page missing from a data center's cache is served as `stale` and re-rendered there, instead of the build-time HTML being served as `fresh` indefinitely.
