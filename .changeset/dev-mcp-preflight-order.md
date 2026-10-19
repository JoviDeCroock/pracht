---
"@pracht/vite-plugin": patch
---

In `pracht dev`, a preflight to the MCP endpoint from an `agents.mcp.allowedOrigins` origin gets the endpoint's own CORS answer instead of Vite's generic one.
