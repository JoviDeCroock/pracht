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
Projected names beyond the 64-character host limit are rejected by verification
and the runtime as well. Accepted JSON-RPC requests keep protocol errors on HTTP
200 so Streamable HTTP clients can parse the structured error response.
Cookie-bearing requests are rejected before capability dispatch,
`Authorization` is forwarded, `Origin` is validated, and destructive
capabilities stay off the MCP surface. Error results keep machine-readable
details in `_meta` instead of off-schema `structuredContent`. The endpoint
supports the `2025-11-25` and `2025-06-18` protocol profiles; MCP-exposed input
and output schemas must be object-rooted until the complete `2026-07-28` wire
codec ships.

`CapabilityAuditEvent.transport` gains `"mcp"`, `AppGraph` gains
`mcpEndpoint`, and `pracht dev` prints the endpoint next to the capability
table (`mcp(unserved)` when `expose.mcp` is declared but no endpoint is
configured).

MCP audit attribution is internal dispatch state rather than a client-set
header. A configured endpoint remains protocol-active with an empty graph and
returns JSON-RPC errors when registry resolution fails. Custom endpoint paths
are validated as exact same-origin pathnames.
