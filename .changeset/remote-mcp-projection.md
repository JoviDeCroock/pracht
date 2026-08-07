---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
---

Serve capabilities as remote MCP tools over stateless Streamable HTTP.

`defineApp({ agents: { mcp: {} } })` opens one endpoint (default `/mcp`)
projecting every capability that sets `expose.mcp` as an MCP tool. It is a
transport adapter, not a second pipeline: `tools/call` synthesizes the request
the HTTP projection would have received and calls the same dispatch, so input
validation, named middleware, `agentPolicy`, output validation, and audit
events are identical across HTTP, WebMCP, and MCP by construction. No MCP SDK
dependency.

`expose.mcp` does not require `expose.http`, so a capability can be reachable
by remote agents without a public browser endpoint. Dotted capability names map
to underscored tool names (`notes.search` → `notes_search`); collisions are a
`pracht verify` error and the runtime refuses to serve an ambiguous tool list.
Cookies are never forwarded to the capability, `Authorization` is; `Origin` is
validated; destructive capabilities stay off the MCP surface.

`CapabilityAuditEvent.transport` gains `"mcp"`, `AppGraph` gains
`mcpEndpoint`, and `pracht dev` prints the endpoint next to the capability
table (`mcp(unserved)` when `expose.mcp` is declared but no endpoint is
configured).
