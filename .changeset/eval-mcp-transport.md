---
"@pracht/cli": minor
"@pracht/capabilities": minor
---

`pracht eval` scenarios can now run over the remote MCP transport with `"transport": "mcp"`.

A scenario that opts in performs a real `initialize` handshake against the app's
MCP endpoint (`/mcp`, or `"mcpPath"`) and issues every step as a `tools/call`
with the projected tool name, so an `expose.mcp` capability is proven the way an
MCP host reaches it. Expectations stay portable between transports: `ok` mirrors
`isError`, `output` matches `structuredContent`, `errorCode` reads the
projection's error metadata, and `status` is the capability dispatch status
(read from the projection's status metadata, not the JSON-RPC POST, which is 200
for every answered call). `signAs` signs the JSON-RPC POSTs, so an
`agentPolicy: "require"` capability is provable over MCP too.

Three MCP limits fail the scenario with an explanation instead of passing
quietly: a capability the endpoint does not project, a step header other than
`authorization` (the projection forwards nothing else), and the destructive
confirmation flow — destructive capabilities cannot be served over MCP today, so
no MCP tool can answer `confirmation_required`; `confirm` is wired to the
`tools/call` `_meta` for when that opt-in lands. The default stays `"http"`;
existing scenarios are unchanged.
