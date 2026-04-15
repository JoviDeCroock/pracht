---
"@pracht/adapter-cloudflare": minor
---

Add `exports` option to re-export Cloudflare primitives (Workflows, Durable Objects, Queues, etc.) from the generated worker entry. Wrangler requires these named exports to discover and register the classes.
