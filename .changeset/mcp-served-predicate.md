---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": patch
---

`pracht verify`, `pracht inspect`, the dev banner, and `/_pracht` now decide whether an `expose.mcp` tool is served with the MCP endpoint's own rule (exported as `mcpToolServing`), so `agents` passed as a shared constant with string module paths no longer reads as unconfigured and scoped tools without `agents.mcp.auth` show as unserved.
