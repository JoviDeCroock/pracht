---
"@pracht/capabilities": patch
"@pracht/core": patch
---

Map capability middleware responses with status 429 to the typed
`rate_limited` error code across HTTP, MCP, generated clients, and direct server
invocation while preserving the middleware's `Retry-After` response header.
