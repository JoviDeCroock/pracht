---
"@pracht/core": minor
---

Attribute composed capability dispatches to the transport that caused them.

`invokeCapability()` is trusted first-party composition: it runs the callee's
own pipeline (input validation, named middleware, `run()`, output validation)
but none of the transport policy that guards the projections — no app-level
`api.middleware`, no `agentPolicy` check, no destructive prepare/commit gate.
A capability an untrusted caller can reach therefore lends that reachability to
everything it composes, which matters most for a remote MCP tool: `expose.mcp`
keeps destructive capabilities off the *tool surface*, but says nothing about
what an exposed tool invokes.

`CapabilityAuditEvent` gains `via`: for a `transport: "server"` dispatch it
carries the transport of the request being served, so an effect a remote agent
triggered through a composing tool is recorded as
`{ transport: "server", via: "mcp" }` instead of looking like an ordinary
loader call. It is `null` for top-level dispatches and outside a served request
(test hosts, scripts), and never reports `"webmcp"` — that marker is
client-declared, so it is not trustworthy enough to attribute a nested effect
to.

The guard boundary itself is unchanged and now documented in
`docs/AGENT_TRUST.md`: gate composed effects inside the composing capability
rather than relying on the callee's exposure rules.
