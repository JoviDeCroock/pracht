---
"@pracht/core": patch
---

Prevent remote MCP tools from bypassing nested capability safety policy through
`invokeCapability()`. MCP-originated composition now re-applies the callee's
`agentPolicy` and refuses destructive effects before their middleware or body
can run, while preserving private non-destructive composition and its named
middleware. Allowed and denied nested calls remain attributable through
`transport: "server"` and `via: "mcp"` audit events.
