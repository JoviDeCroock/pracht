---
"@pracht/capabilities": patch
"@pracht/core": minor
---

Harden remote MCP capability composition, verified agent identity, and audit
attribution.

`CapabilityAuditEvent` gains `via`, which attributes server-side composition to
the trusted HTTP or MCP request that caused it. Audit hooks receive immutable
event and identity snapshots, including through request-local callbacks.

MCP-originated `invokeCapability()` calls now re-apply the callee's
`agentPolicy` and reject destructive effects before middleware or capability
code can run. Trusted MCP provenance is bound to both the incoming transport
request and the synthesized capability request, so adapter contexts that retain
either request cannot escape the nested-call guard. Private non-destructive
composition and named middleware remain available.

Verified Web Bot Auth identity is exposed as a read-only immutable snapshot on
request contexts, capability hosts, audit events, and test hosts. Binding that
identity to frozen or sealed application contexts preserves their receivers,
private fields, callable construction, reflection behavior, and writable source
fields, including live descriptors and overlays frozen after the source was
updated through another retained reference.
