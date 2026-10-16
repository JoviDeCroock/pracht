---
"@pracht/adapter-cloudflare": minor
---

Cloudflare apps can own their Worker module with `cloudflareAdapter({ workerEntry: "/src/worker.ts" })`, serving pracht from its `fetch` through `createPrachtHandler()` from `@pracht/adapter-cloudflare/worker` beside their own Durable Objects, event handlers, and request wrapping.
