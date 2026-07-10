---
"@pracht/cli": patch
---

`pracht build` for Cloudflare targets with Workers Caching enabled no longer emits prerendered time-revalidated ISG pages as static snapshots (they would be served ahead of the Worker and never revalidate). Webhook-only ISG routes keep their snapshots and the worker-managed revalidation path. The `cloudflare:workers` prerender stub now includes the `cache` export.
