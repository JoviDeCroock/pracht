---
"@pracht/adapter-cloudflare": minor
---

Add a `workerHandlersFrom` option to `cloudflareAdapter()`. It points at a
Vite-resolvable module whose named exports (`queue`, `scheduled`, `email`,
`tail`, ...) are merged into the generated worker's default export next to
pracht's `fetch` handler, so apps can consume Queues, Cron Triggers, and Email
Routing without replacing the adapter. `fetch` always remains pracht's
handler.
