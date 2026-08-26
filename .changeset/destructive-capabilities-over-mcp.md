---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
---

Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.

The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved; inspection surfaces and app-graph plans now reflect that distinction.
