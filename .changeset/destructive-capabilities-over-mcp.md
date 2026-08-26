---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
---

Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.

The opt-in serves `expose.mcp` capabilities whose effect is `destructive`, gated by the same server-verified prepare/commit flow HTTP uses — the token travels in `_meta["io.pracht/confirmation"]` on `tools/call`. It fails closed: the endpoint refuses to serve destructive tools unless a durable approval store is registered, a confirmation secret is configured, and (in human mode) a principal can be resolved — a token handed to the committing agent must be consumable exactly once. `createSqlApprovalStore({ execute })` provides that over Postgres, Cloudflare D1, and SQLite/Turso with no driver dependency (see `docs/AGENT_TRUST.md` for the migration). Without the opt-in nothing changes: destructive capabilities stay filtered out of the MCP surface. `defineCapability()` now accepts `destructive` + `expose.mcp` (`expose.webmcp` is still rejected), and nested `invokeCapability()` under an MCP tool allows a destructive callee only when the tool being served already cleared its own confirmation gate — a request-scoped grant matching what a confirmed HTTP endpoint has, not a per-callee check.
