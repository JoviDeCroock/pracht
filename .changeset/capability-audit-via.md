---
"@pracht/capabilities": minor
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
identity to frozen or sealed ordinary application contexts preserves their
receivers, private fields, array branding, callable construction and property
surfaces, reflection behavior, and writable source fields, including live
descriptors, prototype changes made through another retained reference, and
overlays frozen after retained source updates. Application-defined
`Symbol.toStringTag` brands do not change whether an ordinary context can be
overlaid. Immutable native built-ins, including platform globals and
cross-realm instances, fail closed based on their actual prototypes because an
overlay cannot preserve their internal slots; wrap them in a fresh mutable
request-context object. Reusing a context across different
verified identities fails closed, including when immutable contexts require an
overlay, and reflected methods and accessors preserve their original
private-field receivers across integrity operations. Receiver-bound helpers on
immutable contexts continue to observe the original object, so apps that need
helpers to read `agent` or middleware-added state should supply a mutable
per-request context. Every one of these fail-closed cases is delivered as a
response — a 500 from `handlePrachtRequest()`, an `internal_error` envelope from
`invokeCapability()` — never as a rejection out of the adapter. HTTP and MCP
composition retain the transport-verified identity even when application code
supplies a replacement context object to `invokeCapability()`.
