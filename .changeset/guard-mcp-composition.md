---
"@pracht/core": patch
---

Prevent remote MCP tools from bypassing nested capability safety policy through
`invokeCapability()`. MCP-originated composition now re-applies the callee's
`agentPolicy` and refuses destructive effects before their middleware or body
can run, while preserving private non-destructive composition and its named
middleware. Transport-verified identity is bound without requiring a mutable
application context. Allowed and denied nested calls remain attributable
through `transport: "server"` and `via: "mcp"` audit events.
Both the incoming MCP request and synthesized capability request retain trusted
MCP provenance, preventing adapter contexts that store the incoming request
from escaping the nested-call guard.
