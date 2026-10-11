---
"@pracht/capabilities": patch
---

Capability HTTP endpoints and the remote MCP endpoint now refuse request bodies over 1 MiB with a 413 instead of buffering them unbounded.
