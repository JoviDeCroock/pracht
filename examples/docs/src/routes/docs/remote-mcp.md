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

A `destructive` capability needs a third opt-in — see [Destructive Tools](#destructive-tools).

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

The synthesized request carries the same request-bound capability host, so named middleware and capability bodies can compose private non-destructive operations with `invokeCapability()`. Trusted MCP provenance adds two fail-closed rules to ordinary server composition: the nested call re-applies the callee's `agentPolicy`, and refuses `destructive` effects before middleware or the body can run unless the tool being served is itself a destructive capability that already cleared prepare/commit. The incoming transport request carries that provenance too, so adapter context that retains it cannot escape the nested-call guard. Every nested attempt audits as `{ transport: "server", via: "mcp" }`, keeping indirect effects and denials attributable to the agent that caused them.

The endpoint is stateless: no session id, no server→client stream, no resumability. That is what the Node, Cloudflare, Netlify, and Vercel adapters already serve, so the same app runs unchanged on all four.

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

Annotations are hints for the client's UX — never enforcement. The effect class that produced them is what the server actually enforces. Pracht does not claim that a tool is closed-world, so it leaves `openWorldHint` unset and preserves MCP's default. Likewise, `write` capabilities omit `destructiveHint`: a write mutates state but is not necessarily purely additive, so MCP's conservative default applies. A `destructive` capability sets `destructiveHint: true` and carries its confirmation contract in both the description and `_meta`.

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

## Destructive Tools

Off by default. A `destructive` capability that sets `expose.mcp` is filtered out of `tools/list` and `tools/call`, and nested `invokeCapability()` refuses it. Two things turn it on, both explicit:

```ts [src/routes.ts]
export const app = defineApp({
  agents: {
    mcp: {
      serverInfo: { name: "notes", version: "1.4.0" },
      destructive: true,   // serve destructive tools, still confirmation-gated
    },
  },
});
```

```ts [src/server/approvals.ts]
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

// Import this module from a server entry or a capability module so the
// registration runs before the capability graph is served.
setCapabilityApprovalStore(createSqlApprovalStore({ execute }));
```

The setup may instead be imported by app-level capability/API middleware or named middleware on the destructive capability. The endpoint imports those applied middleware modules before checking its preconditions, without running the middleware functions during `tools/list`. `/_pracht` evaluates the real server entry and those applied setup modules, so a failed runtime gate is reported as `mcp(unserved)`. Graph-only commands (`pracht dev`, `pracht inspect capabilities`, and MCP inspection) deliberately skip the adapter server entry; when their local runtime still lacks a precondition, they report `mcp(unverified)` rather than falsely claiming that a server-entry registration is absent. JSON inspection always reports `mcpEndpoint`, `mcpDestructive`, `mcpRuntimeStatus`, and `mcpUnavailableReasons`. The status is `not-configured`, `ready`, `blocked` for a runtime-verified failure, or `unverified` for an inconclusive graph-only check.

The store is not optional. Over MCP the confirmation token is handed to the very agent that will commit with it, and a stateless HMAC token replays until it expires — so exactly-once consumption is the whole reason the transport may carry a destructive effect at all. The runtime is the gate: the endpoint answers an explanatory JSON-RPC error instead of serving destructive tools whenever the store, the confirmation secret, or (in `mode: "human"`) any resolvable principal is missing. A policy-only `webBotAuth: {}` block is not an identity source: configure at least one valid 32-byte base64url Ed25519 static key or HTTPS directory, or register an application principal resolver. `pracht verify` *warns* when it cannot find a `setCapabilityApprovalStore()` call in the configured source directories — a warning, not an error, because a source scan cannot see a registration that lives in a workspace package. There is no silent downgrade in either direction: without the opt-in the tool is invisible; with the opt-in and an unmet precondition, nothing is served. In that state, runtime-backed `/_pracht` marks every MCP exposure as `mcp(unserved)`; graph-only CLI inspection uses `mcp(unverified)` when the same preconditions may still be registered by the skipped adapter server entry. See [Durable Approvals](/docs/agent-trust#durable-approvals) for the store itself.

### Prepare and Commit over `tools/call`

The flow is [the same one HTTP uses](/docs/agent-trust). MCP has no per-call header channel, and the token cannot ride in `arguments` — it is bound to a hash of them — so it travels in `_meta`, the protocol's extension slot.

```jsonc
// 1. Prepare — nothing runs.
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"notes_purge","arguments":{"titlePrefix":"Old"}}}

// → an isError result. The token is in _meta *and* in the text, so hosts
//   that only read text can complete the flow too.
{
  "content": [{ "type": "text", "text": "confirmation_required: …\nConfirmation token …: v2.…" }],
  "isError": true,
  "_meta": {
    "io.pracht/status": 409,
    "io.pracht/error": {
      "code": "confirmation_required",
      "confirmationToken": "v2.<claims>.<hmac>",
      "expiresAt": 1735689720,
      "approvalId": "…"
    }
  }
}

// 2. Commit — identical arguments plus the token.
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"notes_purge","arguments":{"titlePrefix":"Old"},
           "_meta":{"io.pracht/confirmation":"v2.<claims>.<hmac>"}}}
```

Everything the HTTP flow guarantees holds here: the token binds the principal, the capability, and the exact input; a tampered, expired, or replayed token answers `confirmation_invalid`; and in `mode: "human"` the commit answers `confirmation_pending` until a person decides. Each `tools/list` descriptor advertises the contract as `_meta["io.pracht/confirmation"] = { required: true, metaKey: "io.pracht/confirmation" }`, so a host can drive the flow without parsing prose.

---

## Security

Every capability guarantee carries over. The projection adds three of its own:

**Cookie-bearing requests are rejected.** Adapter context factories can decode a session before framework dispatch, so dropping `cookie` only from the synthesized capability request would be too late. The MCP endpoint returns 403 whenever its transport request carries a cookie, ensuring a browser session cannot authenticate remote MCP. `Authorization` *is* forwarded, so your middleware sees the MCP credential.

**Browser-originated requests are rejected.** Remote MCP has no browser use case, so requests carrying `Origin` or `Sec-Fetch-Site` receive 403. This avoids trusting a Host-derived request URL during Origin validation, closing the DNS-rebinding path. Non-browser MCP clients send neither header and are unaffected.

**Destructive capabilities are unreachable without the opt-in.** Without `agents.mcp.destructive` they are filtered out of `tools/list` and `tools/call`, and `invokeCapability()` refuses a destructive callee while serving an MCP tool, even when that callee is private. With the opt-in, a remote agent reaches a destructive effect only through the [prepare/commit flow](#destructive-tools): composition refuses destructive callees unless the tool being served is itself a destructive capability that already cleared its own gate. Note what that does *not* say — once a tool has cleared it, that tool's own `run()` may compose any destructive capability, private ones included, as often as it likes for the rest of the request, exactly as an HTTP endpoint can. The confirmation gates the agent's entry point, not the first-party code behind it; the scope dies with the request.

Every dispatch emits an audit event with `transport: "mcp"` — passed as internal dispatch state rather than read from the public transport-marker header, so unlike the client-declared `"webmcp"` marker it is trustworthy — and anything the tool composes emits its own event carrying `via: "mcp"`.

Authentication has two shapes. Leave `agents.mcp.auth` off and the endpoint is open: authentication is your app's, in the capability's named middleware, which sees the forwarded `Authorization` header. Turn it on and the transport itself becomes an OAuth 2.0 protected resource.

---

## OAuth: Letting a Real Host Connect

An MCP host — Claude, a ChatGPT connector, Inspector — cannot connect to an authenticated server it has to be told about out of band. The [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) answers that with two standards: [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected-resource metadata, and an [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) `WWW-Authenticate` challenge that points at it. Pracht implements the **resource server** half of both.

It is not, and will not become, an authorization server. Token issuance, refresh, consent screens, and client registration belong to the identity provider you already run. Pracht's job is to publish where that provider is, and to check what it issued.

```ts [src/routes.ts]
export const app = defineApp({
  agents: {
    mcp: {
      serverInfo: { name: "notes", version: "1.4.0" },
      auth: {
        // Absolute URL of this endpoint. It is the RFC 8707 audience tokens
        // must be bound to, and the base for the metadata URL hosts discover.
        resource: "https://app.example.com/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["notes.read", "notes.write"],
        requiredScopes: ["notes.read"],          // optional gate on every call
        // Server-only module; its default export verifies one bearer token.
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },
});
```

`verify` is a module reference, not an inline function, for the same reason capabilities and middleware are: the manifest is bundled into the client, and a token verifier — with its JWKS client and issuer configuration — must never be. `pracht verify` and manifest resolution reject a relative `resource`, a `resource` carrying a query or fragment, a `resource` whose path does not address the served endpoint, an empty `authorizationServers`, a scope token that would break the challenge header, and a missing `verify`.

### The Metadata Document

Served unauthenticated and CORS-open — discovery happens before a host has a token — at the RFC 9728 path, where the well-known segment goes *between* the host and the resource's path:

```bash
curl -s https://app.example.com/.well-known/oauth-protected-resource/mcp
```

```json
{
  "resource": "https://app.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["notes.read", "notes.write"],
  "bearer_methods_supported": ["header"]
}
```

The body is byte-stable across requests. The bare `/.well-known/oauth-protected-resource` answers with the same document, because hosts in the wild probe either form. `bearer_methods_supported` is always `["header"]`: pracht reads the `Authorization` header and nothing else — never a form field or query parameter. An explicit API route file at the same path still wins, so an app that wants to serve its own document can.

### The Challenge

| Situation | Answer |
| --- | --- |
| No `Authorization: Bearer` | `401`, `WWW-Authenticate: Bearer resource_metadata="…"` |
| Token present but rejected | `401`, plus `error="invalid_token"` |
| Token valid, scope missing | `403`, plus `error="insufficient_scope"`, `scope="…"` |

```text
WWW-Authenticate: Bearer error="invalid_token",
  error_description="The bearer token is invalid or expired.",
  resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp"
```

`resource_metadata` is the whole point: it is how a host that has never seen this server discovers which authorization server to talk to. Per RFC 6750 the no-credentials challenge carries no `error` code — "authenticate", not "your token is bad".

The check runs alongside the transport hardening above, before the JSON-RPC body is parsed and long before a tool is resolved, so an unauthenticated caller learns nothing about the graph — not even whether a tool name exists. Method, `Origin`, and cookie rejections still come first: a cookie-bearing request is 403 whether or not it also carries a token.

### Writing `verify`

```ts [src/server/mcp-token.ts]
import { createRemoteJWKSet, jwtVerify } from "jose"; // your dependency, not pracht's
import type { McpTokenVerifier } from "@pracht/core";

const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

const verify: McpTokenVerifier = async (token) => {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://auth.example.com",
    // Bind the audience to the resource identifier (RFC 8707). Without this a
    // token minted for another service on the same issuer would be accepted.
    audience: "https://app.example.com/mcp",
  });
  return {
    subject: payload.sub!,
    scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
    clientId: typeof payload.client_id === "string" ? payload.client_id : null,
  };
};

export default verify;
```

`jose` is a documentation choice, not a framework dependency — it runs on Workers and Vercel Edge, which is why the recipe uses it. Any library, or an introspection call to your provider, works the same way.

The hook **fails closed**. Returning `null`, throwing, or returning anything that is not a principal with a non-empty string `subject` all produce the same `401 invalid_token`. A thrown error's message never reaches the caller — it may carry provider internals — and is logged once instead. A `verify` module that cannot be loaded at all answers 401 for every request rather than serving tools unguarded.

### The Verified Principal

The principal is bound to the request context as `context.tokenAuth`, mirroring how [`context.agent`](/docs/agent-trust) carries Web Bot Auth identity:

```ts
async run({ context }) {
  context.tokenAuth; // { subject, scopes?, clientId?, claims? } — frozen
}
```

It is a frozen snapshot on a non-writable, non-configurable framework-owned field. Middleware may derive its own authorization state elsewhere on `context`, but cannot rewrite the identity a later capability or audit check sees. A context that already owns a `tokenAuth` field, is frozen, or is reused across two different principals fails the request with a 500 rather than silently dispatching unauthenticated. `tokenAuth` is absent on every other request path; an unauthenticated MCP request never reaches application code at all.

The two identities compose: `context.agent` says *which agent software* signed the request, `context.tokenAuth` says *on whose behalf* it is acting.

Apps that leave `auth` off pay nothing for it — no metadata route, no header, and no bundle bytes: the auth module sits behind its own dynamic import inside the MCP runtime, which is itself only loaded when `agents.mcp` is configured.

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

For a repeatable check instead of a `curl`, a [`pracht eval`](/docs/agent-trust#the-same-scenario-over-remote-mcp) scenario with `"transport": "mcp"` drives this endpoint the way a host does: one `initialize` handshake, then a `tools/call` per step. That is the difference between a capability that declares `expose.mcp` and one you have proven an MCP host can call.

Once `agents.mcp.auth` is configured, add the token — and point the host at the endpoint, not at the metadata URL; it discovers that itself:

```bash
curl -sX POST https://app.example.com/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Not built yet: an authorization server (pracht is the resource server — issuance and consent stay with your identity provider), `resources/*` and `prompts/*`, streaming and progress, and MCP Apps UI views.

> `pracht mcp` is a different thing entirely: a stdio server that gives *coding* agents access to your app graph while you build. This page is about your deployed app's own tools.
