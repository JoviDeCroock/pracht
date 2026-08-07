# Remote MCP Projection

Serve your app's [capabilities](CAPABILITIES.md) as [Model Context
Protocol](https://modelcontextprotocol.io) tools, over stateless Streamable
HTTP, at one endpoint — for agents that never open a browser.

> Not to be confused with [MCP.md](MCP.md), which documents `pracht mcp`: a
> stdio server that gives *coding* agents access to your app graph at
> development time. This page is about the deployed application's own tools.

## Enabling it

Two opt-ins, both explicit:

```ts
// src/routes.ts
export const app = defineApp({
  agents: {
    mcp: {
      // path: "/mcp",                                   // default
      serverInfo: { name: "notes", version: "1.4.0" },   // reported by initialize
      instructions: "Search and file notes for the signed-in account.",
    },
  },
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
  },
  routes: [/* ... */],
});
```

```ts
// src/capabilities/notes-search.ts
export default defineCapability({
  // ...
  expose: { http: true, mcp: true },
});
```

A capability without `expose.mcp` is invisible to the endpoint, and without
`agents.mcp` nothing is served at all — `pracht verify` warns when a
capability declares `expose.mcp` that no endpoint serves, and `pracht dev`
prints the endpoint next to the capability table.

`expose.mcp` does **not** require `expose.http`: a capability can be reachable
by remote agents without any public browser endpoint.

## It is a transport, not a second pipeline

`tools/call` synthesizes the request the HTTP projection would have received
and hands it to the same dispatch function `/api/capabilities/*` uses. Input
validation, named middleware, `agentPolicy`, output validation, and the audit
event are therefore identical across HTTP, WebMCP, and MCP by construction —
there is no second copy of the rules to drift.

```text
POST /mcp
  → transport checks (method, Accept, Origin, protocol version)
  → tools/list  = projection of the resolved capability graph
  → tools/call  = the capability HTTP dispatch, verbatim
```

Stateless: no session id, no server→client stream, no resumability. That is
what the Node, Cloudflare, and Vercel adapters already serve.

## Tool names

Capability names are dot-separated; MCP hosts widely constrain tool names to
`^[a-zA-Z0-9_-]{1,64}$`. Dots become underscores:

| Capability | Tool |
| --- | --- |
| `notes.search` | `notes_search` |
| `notes.create` | `notes_create` |

Two capabilities that map to the same tool name (`notes.search` and
`notes_search`) are a `pracht verify` error, and the runtime refuses to serve
an ambiguous tool list rather than picking a winner.

## What a tool looks like

`tools/list` projects the capability's own JSON Schemas — nothing is
regenerated or re-described:

```jsonc
{
  "name": "notes_search",
  "title": "Search notes",
  "description": "Find notes whose title or body matches the query.",
  "inputSchema": { /* the capability's input schema */ },
  "outputSchema": { /* the capability's output schema */ },
  "annotations": {
    "readOnlyHint": true,      // derived from effect: "read"
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "_meta": { "io.pracht/capability": "notes.search", "io.pracht/effect": "read" }
}
```

Annotations are client UX hints, never enforcement — the effect class that
produced them is what the server enforces.

Results carry both `structuredContent` (the validated output) and a text
rendering, so hosts that only read text still get something useful:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"notes\": [ … ] }" }],
  "structuredContent": { "notes": [/* … */] },
  "isError": false
}
```

## Errors

The split follows what actually failed:

| Situation | Answer |
| --- | --- |
| Unknown tool, malformed params, bad JSON-RPC | JSON-RPC `error` |
| Unsupported protocol version, non-POST, cross-origin | HTTP 400 / 405 / 403 |
| Validation failure, middleware rejection, policy denial | `isError: true` result |

Execution failures stay results because the call itself succeeded and the
model needs to *read* the failure to react to it. The envelope's error code
and issues travel in `structuredContent`.

## Security

The projection inherits every capability guarantee and adds three of its own:

- **Cookies are never forwarded.** The synthesized request deliberately drops
  `cookie`, so a browser session can never authenticate the remote agent
  transport. `authorization` *is* forwarded, so middleware sees the MCP
  credential. This is a mechanism, not a convention — there is no code path
  that passes a cookie through.
- **Origin is validated.** A page on another origin cannot drive the endpoint
  (DNS rebinding). Non-browser callers send no `Origin` and are unaffected.
- **Destructive capabilities are not exposed.** `expose.mcp` on a
  `destructive` capability is rejected by `defineCapability()`, the registry,
  and `pracht verify`, and the projection filters them again at serve time.
  Agent hosts cannot yet be trusted to carry the prepare/commit flow
  faithfully. See [AGENT_TRUST.md](AGENT_TRUST.md).

Authentication is your app's: put it in the capability's named middleware,
which sees the forwarded `Authorization` header and `context.agent`. Every
dispatch emits an audit event with `transport: "mcp"` — set by the projection
on a request it synthesized itself, so unlike the client-declared `"webmcp"`
marker it is trustworthy.

## Talking to it

```bash
curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"notes_search","arguments":{"query":"roadmap"}}}'
```

Supported protocol versions are negotiated on `initialize`, newest first:
`2026-07-28`, `2025-11-25`, `2025-06-18`. An `MCP-Protocol-Version` header
outside that set is a 400.

`examples/basic` serves this endpoint; `e2e/capabilities.test.ts` exercises
it end to end.

## Not built yet

- **OAuth resource-server metadata** (`/.well-known/oauth-protected-resource`,
  `WWW-Authenticate` on 401). Authentication currently lives in your
  middleware.
- **`resources/*` and `prompts/*`** — only `tools/*` is projected.
- **Destructive capabilities over MCP.** The prepare/commit flow itself
  transfers to the transport unchanged; what it needs first is exactly-once
  commit, which is what the [approval store](AGENT_TRUST.md#durable-approvals)
  provides. Unblocking this is a follow-up.
- **Streaming, progress, cancellation, and elicitation** — all require the
  server→client stream a stateless endpoint does not open.
- **MCP Apps UI views** — capability-graph Stage 3.
