---
"@pracht/adapter-node": minor
"@pracht/cli": patch
---

`nodeAdapter()` accepts `keepAliveTimeoutMs` and `headersTimeoutMs` for the generated server, and graceful shutdown now closes open SSE streams at once instead of waiting out `shutdownTimeoutMs`.
