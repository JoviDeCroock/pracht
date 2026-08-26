---
"@pracht/cli": minor
"@pracht/capabilities": minor
---

`pracht eval` scenarios can now run over the remote MCP transport with `"transport": "mcp"`.

A scenario that opts in performs a real `initialize` handshake against the app's
MCP endpoint (`/mcp`, or `"mcpPath"`) and issues every step as a `tools/call`
with the projected tool name, so an `expose.mcp` capability is proven the way an
MCP host reaches it. `expect` keeps its meaning — `ok` mirrors `isError`,
`output` matches `structuredContent`, `errorCode` reads the projection's error
metadata — `confirm` travels in the call's `_meta`, and `signAs` signs the
JSON-RPC POSTs. `status` is the status of the request actually made (200 for any
answered `tools/call`), and a capability the endpoint does not project fails the
scenario with an explicit message. The default stays `"http"`; existing
scenarios are unchanged.
