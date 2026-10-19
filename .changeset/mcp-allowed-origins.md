---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

`agents.mcp.allowedOrigins` lets listed browser origins call the remote MCP endpoint with CORS; a preflight from an unlisted origin now gets 403 instead of 405, and a client's JSON-RPC response to the endpoint gets 202 instead of 400.
