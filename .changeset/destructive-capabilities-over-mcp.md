---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
"create-pracht": patch
---

Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.

The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, preserves effective MCP status in capability and agent reports, and confines confirmed composition to the active request. Updated starter skills document the new transport contract.
