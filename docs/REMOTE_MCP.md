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

Custom paths must be exact same-origin pathnames beginning with `/`; invalid
values fail manifest validation. The endpoint must not equal a capability's
HTTP exposure path; capability resolution fails until one of them moves. Once configured, the endpoint remains active
with an empty capability graph (`tools/list` returns an empty list), and graph
resolution failures stay on the endpoint as JSON-RPC errors. Endpoint matching
accepts one trailing slash, so `/mcp` and `/mcp/` address the same projection.

`expose.mcp` does **not** require `expose.http`: a capability can be reachable
by remote agents without any public browser endpoint.

The currently supported MCP protocol versions require tool input and output
schemas rooted at `{ type: "object" }`. `defineCapability()`, the runtime
registry, and `pracht verify` reject `expose.mcp` when either schema has a
different root. Non-object schemas remain valid for private, HTTP, and WebMCP
capabilities.

## It is a transport, not a second pipeline

`tools/call` synthesizes the request the HTTP projection would have received
and hands it to the same dispatch function `/api/capabilities/*` uses. Input
validation, named middleware, `agentPolicy`, output validation, and the audit
event are therefore identical across HTTP, WebMCP, and MCP by construction —
there is no second copy of the rules to drift.

The synthesized request carries the same request-bound capability host, so
named middleware and capability bodies can compose registered operations with
`invokeCapability()` exactly as they can during ordinary HTTP dispatch. Private
non-destructive capabilities remain available as building blocks and run their
own validation and named middleware. Because the host also carries trusted MCP
provenance, nested calls re-apply the callee's `agentPolicy` and reject
`destructive` effects before their middleware or body runs. See
[Remote MCP composition is guarded](AGENT_TRUST.md#remote-mcp-composition-is-guarded).
The incoming transport request carries the same provenance, so adapter context
that retains that request cannot escape the nested-call guard.
Every allowed or denied nested dispatch audits as
`{ transport: "server", via: "mcp" }`, so the remote agent's indirect effects
and attempts stay attributable.

```text
POST /mcp
  → transport checks (method, Accept, Origin, protocol version)
  → tools/list  = projection of the resolved capability graph
  → tools/call  = the capability HTTP dispatch, verbatim
```

Stateless: no session id, no server→client stream, no resumability. That is
what the Node, Cloudflare, Netlify, and Vercel adapters already serve.

## Tool names

Capability names are dot-separated; MCP hosts widely constrain tool names to
`^[a-zA-Z0-9_-]{1,64}$`. Dots become underscores:

| Capability | Tool |
| --- | --- |
| `notes.search` | `notes_search` |
| `notes.create` | `notes_create` |

Two capabilities that map to the same tool name (`notes.search` and
`notes_search`) are a `pracht verify` error, and the runtime refuses to serve
an ambiguous tool list rather than picking a winner. Projected names longer
than 64 characters are rejected by verification and the runtime as well.

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
    "idempotentHint": true
  },
  "_meta": { "io.pracht/capability": "notes.search", "io.pracht/effect": "read" }
}
```

Annotations are client UX hints, never enforcement — the effect class that
produced them is what the server enforces. Pracht does not claim that a tool is
closed-world, so it leaves `openWorldHint` unset and preserves MCP's default.
For the same reason, `write` capabilities omit `destructiveHint`: `write` says
that an operation mutates state, but does not prove that it is purely additive,
so MCP's conservative default applies.

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
| Unsupported protocol version, non-POST, browser-originated, cookie-bearing request | HTTP 400 / 405 / 403 |
| Validation failure, middleware rejection, policy denial | `isError: true` result |

Execution failures stay results because the call itself succeeded and the
model needs to *read* the failure to react to it. Their text content names the
error code and issues; the machine-readable payload lives in
`_meta["io.pracht/error"]`. Error results omit `structuredContent`, because any
structured result must match the capability's advertised output schema.

Once a valid JSON-RPC request has been accepted, JSON-RPC errors use HTTP 200
so standard Streamable HTTP clients parse the error payload. Non-2xx statuses
are reserved for transport failures such as invalid HTTP methods, origins, or
protocol versions.

## Security

The projection inherits every capability guarantee and adds three of its own:

- **Cookie-bearing requests are rejected.** Adapters can derive `context` from
  the original request before framework dispatch, so merely dropping `cookie`
  from the synthesized capability request would be too late. The endpoint
  answers 403 whenever the transport request carries a cookie; a browser
  session can therefore never authenticate remote MCP. `authorization` *is*
  forwarded, so middleware sees the MCP credential.
- **Browser-originated requests are rejected.** Remote MCP has no browser use
  case, so requests carrying `Origin` or `Sec-Fetch-Site` receive 403. This
  avoids trusting a Host-derived request URL during Origin validation, closing
  the DNS-rebinding path. Non-browser MCP clients send neither header and are
  unaffected.
- **Destructive capabilities are not reachable.** `expose.mcp` on a
  `destructive` capability is rejected by `defineCapability()`, the registry,
  and `pracht verify`, and the projection filters them again at serve time.
  Agent hosts cannot yet be trusted to carry the prepare/commit flow
  faithfully. See [AGENT_TRUST.md](AGENT_TRUST.md). The same boundary is
  enforced transitively: `invokeCapability()` refuses a destructive callee
  while serving an MCP tool, even when that callee is private.

Authentication is your app's: put it in the capability's named middleware,
which sees the forwarded `Authorization` header and `context.agent`; nested
calls also re-apply the callee's `agentPolicy`. Every dispatch emits an audit
event with `transport: "mcp"` — passed as internal dispatch state by the
projection, never read from the public transport-marker header, so unlike the
client-declared `"webmcp"` marker it is trustworthy — and anything the tool
composes emits its own event carrying `via: "mcp"`.

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
`2025-11-25`, `2025-06-18`. An `MCP-Protocol-Version` header outside that set
is a 400.

`examples/basic` serves this endpoint; `e2e/capabilities.test.ts` exercises
it end to end.

For a repeatable check rather than a curl, `pracht eval` drives this transport
too: a scenario with `"transport": "mcp"` performs the real `initialize`
handshake and issues each step as a `tools/call`, so the thing under test is
what an MCP host would actually do — not the HTTP projection standing in for
it. `examples/basic/evals/notes-mcp.eval.json` is a working scenario; the
format is documented in
[AGENT_TRUST.md](AGENT_TRUST.md#pracht-eval-scripted-agent-task-scenarios).

## Not built yet

- **OAuth resource-server metadata** (`/.well-known/oauth-protected-resource`,
  `WWW-Authenticate` on 401). Authentication currently lives in your
  middleware.
- **`resources/*` and `prompts/*`** — only `tools/*` is projected.
- **The `2026-07-28` wire profile.** It replaces the initialization exchange
  with self-describing requests and requires its own header/result codec; the
  endpoint does not advertise that version until the complete profile ships.
- **Destructive capabilities over MCP.** The prepare/commit flow itself
  transfers to the transport unchanged; what it needs first is exactly-once
  commit, which is what the [approval store](AGENT_TRUST.md#durable-approvals)
  provides. Unblocking this is a follow-up.
- **Streaming, progress, cancellation, and elicitation** — all require the
  server→client stream a stateless endpoint does not open.
- **MCP Apps UI views** — capability-graph Stage 3.
