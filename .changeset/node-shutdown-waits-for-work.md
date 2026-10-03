---
"@pracht/adapter-node": minor
---

The generated Node server now waits for in-flight requests and their `waitUntil()` work on `SIGTERM`/`SIGINT`, up to `nodeAdapter({ shutdownTimeoutMs })` (default 10s).
