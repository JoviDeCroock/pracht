---
"@pracht/capabilities": patch
"@pracht/core": patch
---

A capability's `signal` now aborts when the HTTP or remote MCP caller disconnects, and it uses `defineApp({ loaderTimeoutMs })` as its budget instead of a fixed 30 seconds.
