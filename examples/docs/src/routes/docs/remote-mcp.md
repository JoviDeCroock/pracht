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

`expose.mcp` does **not** require `expose.http`. A capability can be reachable by remote agents with no public browser endpoint at all.

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
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

Annotations are hints for the client's UX — never enforcement. The effect class that produced them is what the server actually enforces.

Capability names are dot-separated; MCP hosts widely constrain tool names to `^[a-zA-Z0-9_-]{1,64}$`, so `notes.search` becomes `notes_search`. Two capabilities that would collide (`notes.search` and `notes_search`) are a `pracht verify` error, and the runtime refuses to serve an ambiguous tool list rather than picking a winner.

Results carry both the validated output and a text rendering, so hosts that only read text still get something useful:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"notes\": [ … ] }" }],
  "structuredContent": { "notes": [/* … */] },
  "isError": false
}
```

Failures split by what actually failed. An unknown tool or malformed params is a JSON-RPC `error`; a validation failure, middleware rejection, or policy denial is an `isError: true` result carrying the envelope's error code and issues — because the call itself succeeded, and the model needs to read the failure to react to it.

---

## Security

Every capability guarantee carries over. The projection adds three of its own:

**Cookies are never forwarded.** The synthesized request drops `cookie`, so a browser session can never authenticate the remote agent transport. `Authorization` *is* forwarded, so your middleware sees the MCP credential. This is a mechanism rather than a convention — there is no code path that passes a cookie through.

**Origin is validated.** A page on another origin cannot drive the endpoint. Non-browser callers send no `Origin` and are unaffected.

**Destructive capabilities are not exposed.** `expose.mcp` on a `destructive` capability is rejected by `defineCapability()`, the registry, and `pracht verify` — and filtered again at serve time. Agent hosts cannot yet be trusted to carry the [prepare/commit flow](/docs/agent-trust) faithfully.

Authentication is your app's, in the capability's named middleware. Every dispatch emits an audit event with `transport: "mcp"` — set by the projection on a request it synthesized itself, so unlike the client-declared `"webmcp"` marker it is trustworthy.

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

Protocol versions are negotiated on `initialize`, newest first: `2026-07-28`, `2025-11-25`, `2025-06-18`.

Not built yet: OAuth resource-server metadata (authentication lives in your middleware for now), `resources/*` and `prompts/*`, streaming and progress, and MCP Apps UI views.

> `pracht mcp` is a different thing entirely: a stdio server that gives *coding* agents access to your app graph while you build. This page is about your deployed app's own tools.
