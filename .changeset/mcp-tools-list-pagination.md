---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": patch
---

Remote MCP `tools/list` now pages its results (100 tools per page by default, configurable with `agents.mcp.pageSize`), and `expose: { mcp: { scopes } }` limits a tool to OAuth tokens that carry those scopes.
