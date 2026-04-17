---
"@pracht/adapter-cloudflare": minor
---

Add a `workerExportsFrom` option so Cloudflare primitives (Workflows, Durable
Objects, Queues, etc.) can be re-exported from a dedicated user-owned module
instead of duplicating names and file paths in `vite.config.ts`.
