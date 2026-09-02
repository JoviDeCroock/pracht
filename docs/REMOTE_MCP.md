# Remote MCP Projection

Serve your app's [capabilities](CAPABILITIES.md) as [Model Context
Protocol](https://modelcontextprotocol.io) tools, over stateless Streamable
HTTP, at one endpoint — for agents that never open a browser.

> Not to be confused with [MCP.md](MCP.md), which documents `pracht dev-mcp`: a
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

Remote MCP requires a request runtime. `@pracht/adapter-static` rejects any
`agents.mcp` configuration during `pracht verify` and `pracht build`; remove the
endpoint or deploy with a serverful adapter.

`expose.mcp` does **not** require `expose.http`: a capability can be reachable
by remote agents without any public browser endpoint.

A `destructive` capability needs a third opt-in — see [Destructive
tools](#destructive-tools).

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
provenance and OAuth principal, nested calls re-apply the callee's `agentPolicy`,
reject `destructive` effects before their middleware or body runs unless the
tool being served already cleared prepare/commit, and rebind
`context.tokenAuth` to the identity the transport verified. A cleared
destructive tool grants that request's server code the same destructive scope
as a confirmed HTTP endpoint. See
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
so MCP's conservative default applies. A `destructive` capability sets
`destructiveHint: true` and carries the confirmation contract in both its
description and `_meta` — see [Destructive tools](#destructive-tools).

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
| Missing, rejected, or under-scoped bearer token (when `agents.mcp.auth` is set) | HTTP 401 / 403 with `WWW-Authenticate` |
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

## Destructive tools

Off by default. A `destructive` capability that sets `expose.mcp` is filtered
out of `tools/list` and `tools/call`, and nested `invokeCapability()` refuses
it. Two things turn it on, both explicit:

```ts
export const app = defineApp({
  agents: { mcp: { destructive: true } },
  // ...
});
```

```ts
// src/server/approvals.ts — imported by a server entry or a capability module
import { createSqlApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";
setCapabilityApprovalStore(createSqlApprovalStore({ execute }));
```

The setup may instead be imported by app-level capability/API middleware or
named middleware on the destructive capability. The endpoint imports those
applied middleware modules before checking its preconditions, without running
the middleware functions during `tools/list`. `/_pracht` evaluates the real
server entry and those applied setup modules, so a failed runtime gate is
reported as `mcp(unserved)`. Graph-only commands (`pracht dev`, `pracht inspect
capabilities`, and MCP inspection) deliberately skip the adapter server entry;
when their local runtime still lacks a precondition, they report
`mcp(unverified)` rather than falsely claiming that a server-entry registration
is absent. JSON inspection always reports `mcpEndpoint`, `mcpDestructive`,
`mcpRuntimeStatus`, and `mcpUnavailableReasons`. The status is
`not-configured`, `ready`, `blocked` for a runtime-verified failure, or
`unverified` for an inconclusive graph-only check.

The store is not optional. Over MCP the confirmation token is handed to the
very agent that will commit with it, and a stateless HMAC token replays until
it expires — so exactly-once consumption is the whole reason the transport may
carry a destructive effect at all. The runtime is the gate: the endpoint
answers an explanatory JSON-RPC error instead of serving destructive tools
whenever the store, the confirmation secret, or (in `mode: "human"`) any
resolvable principal is missing. A policy-only `webBotAuth: {}` block is not an
identity source: configure at least one valid 32-byte base64url Ed25519 static
key or HTTPS directory, or register an application principal resolver. `pracht verify` *warns* when it
cannot find a `setCapabilityApprovalStore()` call in the configured source
directories — a warning rather than an error because a source scan cannot see a
registration that lives in a workspace package. There is no silent downgrade
in either direction: without the opt-in the tool is invisible; with it and an
unmet precondition, nothing is served. The runtime-backed `/_pracht` graph marks
every MCP exposure as `mcp(unserved)` when this endpoint-wide gate is closed. The
graph-only CLI surfaces use `mcp(unverified)` for the same locally observed
missing preconditions because setup may still run from the skipped adapter
server entry.

### Prepare and commit over `tools/call`

The flow is [the same one HTTP uses](AGENT_TRUST.md#preparecommit) — a
transport detail changes, nothing else. MCP has no per-call header channel and
the token cannot travel in `arguments` (it is bound to a hash of the
canonicalized input), so it uses `_meta`, the protocol's extension slot.

```jsonc
// 1. Prepare — nothing runs.
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"notes_purge","arguments":{"titlePrefix":"Old"}}}

// → isError result; the token is in _meta and in the text, so text-only
//   hosts can complete the flow too.
{
  "content": [{ "type": "text", "text": "confirmation_required: …\nConfirmation token …: v1.…" }],
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

Everything the HTTP flow guarantees holds here: the token is bound to the
principal, the capability, and the exact input; a tampered, expired, or
replayed token answers `confirmation_invalid`; and in `mode: "human"` the commit
answers `confirmation_pending` until a person decides. Each `tools/list`
descriptor advertises the contract as
`_meta["io.pracht/confirmation"] = { required: true, metaKey: "io.pracht/confirmation" }`.

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
- **Destructive capabilities are unreachable without the opt-in.** Without
  `agents.mcp.destructive` the projection filters them out of `tools/list` and
  `tools/call`, and `invokeCapability()` refuses a destructive callee while
  serving an MCP tool, even when that callee is private. With the opt-in, a
  remote agent reaches a destructive effect only through the
  [prepare/commit flow](#destructive-tools): composition refuses destructive
  callees unless the tool being served is a destructive capability that already
  cleared its own gate. Note what that *does not* say — once a tool has cleared
  it, that tool's own `run()` may compose any destructive capability, private
  ones included, as often as it likes for the rest of the request, exactly as an
  HTTP endpoint can. The confirmation gates the agent's entry point, not the
  first-party code behind it. See
  [AGENT_TRUST.md](AGENT_TRUST.md#remote-mcp-composition-is-guarded).

Every dispatch emits an audit event with `transport: "mcp"` — passed as
internal dispatch state by the projection, never read from the public
transport-marker header, so unlike the client-declared `"webmcp"` marker it is
trustworthy — and anything the tool composes emits its own event carrying
`via: "mcp"`.

Authentication has two shapes. Without `agents.mcp.auth` (below) the endpoint is
open and authentication is your app's: put it in the capability's named
middleware, which sees the forwarded `Authorization` header and `context.agent`.
With it, the transport itself becomes an OAuth 2.0 protected resource.

## OAuth resource-server metadata

MCP hosts (Claude, ChatGPT connectors, Inspector) cannot connect to an
authenticated server they have to be told about out of band. The
[MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
answers that with two standards: [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)
protected-resource metadata, and an
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) `WWW-Authenticate` challenge
that points at it. Pracht implements the **resource server** half of both.

It is not, and will not become, an authorization server. Token issuance,
refresh, consent screens, and dynamic client registration belong to an identity
provider you already run (Auth0, Clerk, Entra, Keycloak, WorkOS, your own).
Pracht's job is to publish where that provider is and to check what it issued.

```ts
// src/routes.ts
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
        resourceDocumentation: "https://app.example.com/docs/mcp", // optional
        // Server-only module; its default export verifies one bearer token.
        verify: () => import("./server/mcp-token.ts"),
      },
    },
  },
  // capabilities, routes, ...
});
```

`verify` is a module reference, not an inline function, for the same reason
capabilities and middleware are: the manifest is bundled into the client, and a
token verifier — with its JWKS client and issuer configuration — must never be.
Verifier lookup rejects ambiguous suffixes across `src/server/`,
`src/middleware/`, and `src/capabilities/`; use a root-relative reference such
as `() => import("/src/server/mcp-token.ts")` when duplicate suffixes exist.
Source directories may overlap; duplicate registry entries for the same
normalized file are treated as one verifier, not as an ambiguous reference.
`resolveApp()` and `pracht verify` reject a relative `resource`, a `resource`
carrying a query, fragment, or non-root trailing slash, a `resource` whose path
does not exactly identify the served endpoint, a non-loopback cleartext URL, an
non-canonical resource or issuer spelling, an authorization-server issuer with
a query or fragment, an empty
`authorizationServers`, a scope token outside OAuth's printable-ASCII grammar,
unknown keys under `agents.mcp` or `agents.mcp.auth`, and a missing or
non-callable default `verify` export. HTTP is accepted only for loopback
development (`localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`); deployed
resource and issuer URLs must use HTTPS. Use canonical URL spellings: uppercase
hosts, default ports, and dot segments can serialize to a different OAuth
identifier. `/mcp/` is not equivalent to `/mcp`, even though routing accepts
either spelling. Authenticated endpoints redirect every non-canonical request
spelling, alternate host, and query-bearing request to `resource` with `308`
before challenging or verifying it.

Graph-only inspection loads the configured verifier before calling a protected
endpoint ready. A missing module or non-callable default export sets
`mcpRuntimeStatus` to `blocked`, records the reason in `mcpUnavailableReasons`,
and renders its MCP exposures as `mcp(unserved)` in `pracht dev` and `pracht
inspect`.

The MCP path must also be distinct from every explicit API route. `pracht
verify` rejects exact and dynamic collisions. For example,
`agents.mcp.path: "/api/mcp"` collides with either `src/api/mcp.ts` or an API
pattern like `/api/:name`; the request runtime returns 500 rather than letting
the API handler shadow MCP's transport and authentication gates.
The endpoint also owns its pathname ahead of page rendering and deployment
static rewrites. Do not assign a page route the same path; Vercel's generated
route table sends the MCP endpoint to the runtime before any matching SSG
rewrite, so a method-agnostic static rule cannot intercept `POST /mcp`.

The committed app-graph snapshot records whether the endpoint is OAuth
protected and its resource, authorization servers, required and advertised
scopes, and verifier module. `pracht plan` reports policy changes as well as
enabling protection. Removing a required scope, trusting another authorization
server, or removing auth from a still-live endpoint is marked as a guard
weakening, so the trust-boundary change cannot hide behind an unchanged `/mcp`
path.

### The metadata document

Served unauthenticated, with `Access-Control-Allow-Origin: *` (discovery
happens before a host has a token, and in-browser hosts need to read it), at the
RFC 9728 path — the well-known segment goes *between* the host and the
resource's path:

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

The body is byte-stable across requests. The bare
`/.well-known/oauth-protected-resource` answers with the same document, because
hosts in the wild probe either form. `bearer_methods_supported` is always
`["header"]`: Pracht reads the `Authorization` header and nothing else — never a
form field or query parameter.

**Under a deploy base, the document is still at the origin root.** RFC 9728
inserts the well-known segment between the host and the resource's path, so the
base ends up *inside* the suffix rather than in front of it. An app mounted at
`/app/` whose endpoint is `https://app.example.com/app/mcp` publishes at:

```text
https://app.example.com/.well-known/oauth-protected-resource/app/mcp
```

That is what the `WWW-Authenticate` challenge advertises and what the runtime
serves — the path is matched before base stripping, precisely so the advertised
URL is fetchable. Set `resource` to the endpoint's real deployed URL, base
included; the framework derives the rest. A reverse proxy that re-prefixes the
base onto the well-known path is tolerated too. When `agents.mcp.path` is `/`,
the resource is the deployed app root itself (`https://app.example.com/app` for
that same base). At the origin root, use the canonical slashless identifier
`https://app.example.com`; URL serialization still routes requests at `/`.

Because the match happens before routing and production-adapter static lookup,
neither an application route nor a copied static file can shadow the document
on Node, Cloudflare, Netlify, or Vercel. The bare metadata path is reserved and
cannot be used as `agents.mcp.path`; choose another endpoint path instead.
Netlify `excludedPath` entries that would bypass either the protected MCP
resource path or this reserved metadata namespace are rejected when MCP OAuth
is enabled; apps without `agents.mcp.auth` keep their existing exclusions
because they serve no protected-resource metadata.

### The challenge

| Situation | Answer |
| --- | --- |
| Request URL is not exactly `resource` | `308` to the configured canonical URL; no challenge or token verification |
| No `Authorization: Bearer` | `401`, `WWW-Authenticate: Bearer resource_metadata="…"` and configured `scope="…"` |
| Token present but rejected | `401`, plus `error="invalid_token"` and configured `scope="…"` |
| Token valid, scope missing | `403`, plus `error="insufficient_scope"`, `scope="…"` |

```text
WWW-Authenticate: Bearer error="invalid_token",
  error_description="The bearer token is invalid or expired.",
  resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp",
  scope="notes.read"
```

`resource_metadata` is the whole point: it is how a host that has never seen
this server discovers which authorization server to talk to. Per RFC 6750 the
no-credentials challenge carries no `error` code — "authenticate", not "your
token is bad". When `requiredScopes` is configured, every challenge includes
those scopes so the host can request the right grant on its first authorization
attempt. The body repeats the same fields as JSON.

The check runs with the existing transport hardening, before the JSON-RPC body
is parsed and long before a tool is resolved, so an unauthenticated caller
learns nothing about the graph — not even whether a tool name exists. Method,
`Origin`, and cookie rejections still come first: a cookie-bearing request is
403 whether or not it also carries a token.

### Writing `verify`

```ts
// src/server/mcp-token.ts
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

`jose` is a documentation choice, not a framework dependency — it works on
Workers and Vercel Edge, which is why the recipe uses it. Any library, or an
introspection call to your provider, works the same way.

The hook **fails closed**: returning `null`, throwing, or returning anything
that is not a principal with a non-empty string `subject` all produce the same
`401 invalid_token`. A thrown error's message never reaches the caller (it may
carry provider internals); it is logged once. A `verify` module that cannot be
loaded at all answers 401 for every request rather than serving tools unguarded.
The verifier's second argument contains an independent `request` clone. It may
inspect headers, URL, or even read the JSON-RPC body without consuming the body
the MCP dispatcher reads afterward.

### The verified principal

The principal is bound to the request context as `context.tokenAuth`, alongside
[`context.agent`](AGENT_TRUST.md#web-bot-auth-verified-agent-identity):

```ts
async run({ context }) {
  context.tokenAuth; // { subject, scopes?, clientId?, claims? } — frozen
}
```

It is a frozen snapshot on a non-writable, non-configurable framework-owned
field of a fresh request-local context overlay. Middleware may derive its own
authorization state elsewhere on `context`, but cannot rewrite the identity a
later capability or audit check sees. The adapter-supplied base context is left
unchanged, so reusing it cannot carry one caller's principal into another
request. `tokenAuth` is absent on every other request path; an unauthenticated
MCP request never reaches route middleware, API handlers, or capability code.
When an MCP tool composes another capability, a replacement `context.tokenAuth`
passed to `invokeCapability()` is shadowed by this verified principal.
An adapter's `createContext` hook may run before MCP authentication, so treat
its request as untrusted and avoid privileged or expensive work based only on
reachability.

Precisely what happens to the context object:

| Context | Result |
| --- | --- |
| Ordinary object, class instance, function, or array | Fresh overlay; reads and receiver-sensitive methods still reach the supplied context |
| Same supplied context reused for another request or principal | Fresh overlay with only that request's principal; the supplied context remains unchanged |
| Already owns a `tokenAuth` field | `500`; the field is framework-reserved |
| Frozen or sealed ordinary context | Accepted through the request-local overlay |
| Native built-in requiring internal slots, such as `Map` or `Date` | `500` with guidance to wrap it in an ordinary request context |

The overlay preserves private-field and accessor receivers for class instances,
keeps array behavior, and composes with the `context.agent` overlay. Native
built-ins fail closed because a proxy cannot preserve their internal-slot
identity; wrap one as a property of an ordinary context instead.

`claims` is frozen **shallowly** — its own keys cannot be added, removed, or
rewritten, but nested values are whatever your verifier returned and stay
mutable. Deep-freezing would reach into objects your code still owns (a `jose`
JWT payload, say). The framework never reads `claims`, and the whole principal
is request-local, so even a nested mutation cannot carry authorization state
into a later request through a reused adapter context.

The two identities compose: `context.agent` says *which agent software* signed
the request, `context.tokenAuth` says *on whose behalf* it is acting.

### Cost when unused

An app without `agents.mcp.auth` gets no metadata route, no `WWW-Authenticate`
header, and no new bytes: the auth module is behind its own dynamic import from
the MCP runtime, which is itself only imported when `agents.mcp` is configured,
and the manifest validation is inside the `__PRACHT_AGENT_SURFACE__` guard the
build folds away for apps that configure no agents at all.

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
it. For a protected endpoint, set
`"mcpHeaders": { "authorization": "Bearer …" }` so the token is present during
initialization and every later request; keep real tokens out of committed
scenarios. `examples/basic/evals/notes-mcp.eval.json` is a working scenario; the
format is documented in
[AGENT_TRUST.md](AGENT_TRUST.md#pracht-eval-scripted-agent-task-scenarios).

## Not built yet

- **Authorization-server duties.** Pracht is the resource server
  ([above](#oauth-resource-server-metadata)); token issuance, dynamic client
  registration (RFC 7591), and consent UI stay with your identity provider.
- **The OAuth subject in audit events.** `CapabilityAuditEvent` carries the Web
  Bot Auth `agent`, not `context.tokenAuth`, so an audited MCP dispatch names
  the calling software but not the account it acted for. Capture the principal
  in named middleware or capability code while request context is available and
  send it to the same audit sink until the event gains a field for it — a
  follow-up.
- **`resources/*` and `prompts/*`** — only `tools/*` is projected.
- **The `2026-07-28` wire profile.** It replaces the initialization exchange
  with self-describing requests and requires its own header/result codec; the
  endpoint does not advertise that version until the complete profile ships.
- **Streaming, progress, cancellation, and elicitation** — all require the
  server→client stream a stateless endpoint does not open.
- **MCP Apps UI views** — capability-graph Stage 3.
