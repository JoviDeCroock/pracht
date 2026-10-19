---
"@pracht/adapter-node": patch
---

A graceful shutdown now ends open SSE streams as complete responses instead of cutting their connections, so `EventSource` clients reconnect without logging a network error.
