---
title: Remote MCP
lead: Serve your app's capabilities as Model Context Protocol tools over stateless Streamable HTTP — one endpoint, for agents that never open a browser. A transport over the dispatch you already have, not a second pipeline.
breadcrumb: Remote MCP
prev:
  href: /docs/agent-trust
  title: Agent Trust
next:
  href: /docs/recipes/i18n
  title: i18n
---

## Two Opt-Ins

WebMCP puts your operations in front of an agent standing in the user's tab. Remote MCP puts the same operations in front of an agent that never opens a browser at all — a coding assistant, a scheduled workflow, someone's terminal.

Nothing is served until you ask for it twice: the app has to configure an endpoint, and each capability has to declare the exposure.

```ts [src/routes.ts]
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
});
```

```ts [src/capabilities/notes-search.ts]
export default defineCapability({
  // ...
  expose: { http: true, mcp: true },
});
```

`pracht dev` prints the endpoint next to the capability table, and `pracht verify` warns when a capability declares `expose.mcp` that no endpoint serves — a declared-but-dead transport is never mistaken for a live one.

Custom paths must be exact same-origin pathnames beginning with `/`; invalid values fail manifest validation. The endpoint must not equal a capability's HTTP exposure path; capability resolution fails until one path moves. Once configured, the endpoint remains active with an empty capability graph (`tools/list` returns an empty list), and graph resolution failures stay on the endpoint as JSON-RPC errors. Endpoint matching accepts one trailing slash, so `/mcp` and `/mcp/` address the same projection.

`expose.mcp` does **not** require `expose.http`. A capability can be reachable by remote agents with no public browser endpoint at all.

The supported MCP versions require both tool schemas to be rooted at `{ type: "object" }`. `defineCapability()`, the runtime registry, and `pracht verify` reject `expose.mcp` when either the input or output schema uses another root; those schemas remain valid for private, HTTP, and WebMCP capabilities.

---

## A Transport, Not a Second Pipeline

`tools/call` synthesizes the request the HTTP projection would have received and hands it to the same dispatch function `/api/capabilities/*` uses:

```text
POST /mcp
  → transport checks (method, Accept, Origin, protocol version)
  → tools/list  = projection of the resolved capability graph
  → tools/call  = the capability HTTP dispatch, verbatim
```

Input validation, named middleware, `agentPolicy`, output validation, and the audit event are identical across HTTP, WebMCP, and MCP *by construction* — there is no second copy of the rules that could drift from the first.

The synthesized request carries the same request-bound capability host, so named middleware and capability bodies can compose private non-destructive operations with `invokeCapability()`. Trusted MCP provenance adds two fail-closed rules to ordinary server composition: the nested call re-applies the callee's `agentPolicy` and refuses `destructive` effects before middleware or the body can run. Every nested attempt audits as `{ transport: "server", via: "mcp" }`, keeping indirect effects and denials attributable to the agent that caused them.

The endpoint is stateless: no session id, no server→client stream, no resumability. That is what the Node, Cloudflare, and Vercel adapters already serve, so the same app runs unchanged on all three.

---

## What an Agent Sees

`tools/list` projects the capability's own JSON Schemas. Nothing is regenerated, and nothing is re-described in a second place:

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
  }
}
```

Annotations are hints for the client's UX — never enforcement. The effect class that produced them is what the server actually enforces. Pracht does not claim that a tool is closed-world, so it leaves `openWorldHint` unset and preserves MCP's default. Likewise, `write` capabilities omit `destructiveHint`: a write mutates state but is not necessarily purely additive, so MCP's conservative default applies.

Capability names are dot-separated; MCP hosts widely constrain tool names to `^[a-zA-Z0-9_-]{1,64}$`, so `notes.search` becomes `notes_search`. Two capabilities that would collide (`notes.search` and `notes_search`) are a `pracht verify` error, and the runtime refuses to serve an ambiguous tool list rather than picking a winner. Projected names longer than 64 characters are rejected by verification and the runtime as well.

Results carry both the validated output and a text rendering, so hosts that only read text still get something useful:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"notes\": [ … ] }" }],
  "structuredContent": { "notes": [/* … */] },
  "isError": false
}
```

Failures split by what actually failed. An unknown tool or malformed params is a JSON-RPC `error`; a validation failure, middleware rejection, or policy denial is an `isError: true` result whose text names the error and whose `_meta["io.pracht/error"]` carries the machine-readable code and issues. Error results omit `structuredContent`, because structured results must match the capability's advertised output schema.

Once a valid JSON-RPC request has been accepted, JSON-RPC errors use HTTP 200 so standard Streamable HTTP clients parse the error payload. Non-2xx statuses are reserved for transport failures such as invalid HTTP methods, origins, or protocol versions.

---

## Security

Every capability guarantee carries over. The projection adds three of its own:

**Cookie-bearing requests are rejected.** Adapter context factories can decode a session before framework dispatch, so dropping `cookie` only from the synthesized capability request would be too late. The MCP endpoint returns 403 whenever its transport request carries a cookie, ensuring a browser session cannot authenticate remote MCP. `Authorization` *is* forwarded, so your middleware sees the MCP credential.

**Browser-originated requests are rejected.** Remote MCP has no browser use case, so requests carrying `Origin` or `Sec-Fetch-Site` receive 403. This avoids trusting a Host-derived request URL during Origin validation, closing the DNS-rebinding path. Non-browser MCP clients send neither header and are unaffected.

**Destructive capabilities are not reachable.** `expose.mcp` on a `destructive` capability is rejected by `defineCapability()`, the registry, and `pracht verify` — and filtered again at serve time. Agent hosts cannot yet be trusted to carry the [prepare/commit flow](/docs/agent-trust) faithfully. The same boundary applies transitively: `invokeCapability()` refuses a destructive callee while serving an MCP tool, even when that callee is private.

Authentication is your app's, in the capability's named middleware; nested calls also re-apply the callee's `agentPolicy`. Every dispatch emits an audit event with `transport: "mcp"` — passed as internal dispatch state rather than read from the public transport-marker header, so unlike the client-declared `"webmcp"` marker it is trustworthy — and anything the tool composes emits its own event carrying `via: "mcp"`.

---

## Talking to It

```bash
curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"notes_search","arguments":{"query":"roadmap"}}}'
```

Protocol versions are negotiated on `initialize`, newest first: `2025-11-25`, `2025-06-18`. The `2026-07-28` profile is not advertised until its self-describing request headers and result codec are implemented together.

Not built yet: OAuth resource-server metadata (authentication lives in your middleware for now), `resources/*` and `prompts/*`, streaming and progress, and MCP Apps UI views.

> `pracht mcp` is a different thing entirely: a stdio server that gives *coding* agents access to your app graph while you build. This page is about your deployed app's own tools.
