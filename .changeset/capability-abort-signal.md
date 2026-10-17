---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/vite-plugin": patch
---

A capability's `signal` now aborts when the HTTP or remote MCP caller disconnects, and it uses `defineApp({ loaderTimeoutMs })` as its budget instead of a fixed 30 seconds; on the Node adapter `request.signal` no longer aborts as soon as a POST body has been read, and `pracht dev` now aborts it when the client disconnects.
