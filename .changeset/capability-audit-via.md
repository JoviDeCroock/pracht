---
"@pracht/core": minor
---

Attribute composed capability dispatches to the transport that caused them.

`invokeCapability()` is trusted first-party composition: it runs the callee's
own pipeline (input validation, named middleware, `run()`, output validation)
without re-running app-level `api.middleware`. Remote MCP provenance is carried
separately so the runtime can attribute nested work and enforce the MCP-specific
agent-policy and destructive-effect boundary.

`CapabilityAuditEvent` gains `via`: for a `transport: "server"` dispatch it
carries the transport of the request being served, so an effect a remote agent
triggered through a composing tool is recorded as
`{ transport: "server", via: "mcp" }` instead of looking like an ordinary
loader call. It is `null` for top-level dispatches and outside a served request
(test hosts, scripts), and never reports `"webmcp"` — that marker is
client-declared, so it is not trustworthy enough to attribute a nested effect
to. Both the module-level audit hook and `handlePrachtRequest()`'s request-local
`onCapabilityAudit` callback receive the composed event.

The composition boundary and its MCP-specific safeguards are documented in
`docs/AGENT_TRUST.md`.
