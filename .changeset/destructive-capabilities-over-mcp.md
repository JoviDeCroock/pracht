---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
"create-pracht": patch
---

Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.

The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, distinguishes graph-only unverified setup from a verified runtime failure, and shares confirmed composition across the request. Updated starter skills document the new transport contract.
