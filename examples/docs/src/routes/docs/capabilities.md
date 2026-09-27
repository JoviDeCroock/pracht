---
title: Capabilities
lead: Define a typed operation once and pracht projects it everywhere — direct server calls, a generated HTTP endpoint, a WebMCP page tool for in-browser agents, and a tool on your app's own remote MCP endpoint. Explicit, validated, and private by default.
breadcrumb: Capabilities
prev:
  href: /docs/agents
  title: The Agentic Web
next:
  href: /docs/standalone-capabilities
  title: Standalone Capabilities
---

> **Both routers.** Manifest apps register capabilities through `defineApp({ capabilities })`. [Pages-router](/docs/routing#capabilities-via-srccapabilities) apps auto-discover every module in `src/capabilities/` and configure `agents` from `src/pages/_app.config.ts`; everything on this page — HTTP endpoints, WebMCP, remote MCP, typed clients, `pracht eval` — works the same in both.

## One Contract, Many Surfaces

A capability is a typed, protocol-neutral application operation: JSON Schema input and output, an effect class (`read`, `write`, or `destructive`), optional named middleware, and a server-only `run()` function. From that single contract pracht generates:

- **Direct server invocation** — `invokeCapability()` from loaders, API routes, and middleware.
- **An HTTP endpoint** — `POST /api/capabilities/<name>` when `expose.http` is set.
- **A WebMCP page tool** — eligible for route-scoped browser registration when `expose.webmcp` is set.
- **A remote MCP tool** — served at your app's own endpoint when `expose.mcp` is set, for agents that never open a browser. See [Remote MCP](#remote-mcp-tools-for-agents-without-a-browser).

Every projection runs the same pipeline, so business rules never diverge between transports:

```text
input validation → middleware chain → run() → output validation → audit event
```

---

## Register capabilities

Capabilities are registered in `defineApp()`, like shells and middleware. No API route or loader is ever inferred as one. `expose.webmcp` only makes a capability eligible to be a page tool. Each route lists the tools that exist on that page.

```ts [src/routes.ts]
import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
    "notes.create": () => import("./capabilities/notes-create.ts"),
  },
  routes: [
    route("/", "./routes/home.tsx"),
    route("/notes", "./routes/notes.tsx", {
      capabilities: ["notes.search", "notes.create"],
    }),
  ],
});
```

`group({ capabilities: [...] }, routes)` adds tools to every child, and route-level names add to that set. `pracht verify` rejects an unknown name, a capability without `expose.webmcp`, and any tool on a `hydration: "none"` route.

With the pages router, every module in `src/capabilities/` is registered automatically. Name it with `defineCapability({ name })` or let the filename provide it (`notes-search.ts` becomes `notes.search`). A page opts into its tools with an inline `CAPABILITIES` array on the page itself, not `_app.tsx` or `404.tsx`. See [Pages Router](/docs/routing#capabilities-via-srccapabilities).

```ts [src/pages/notes.tsx]
export const CAPABILITIES = ["notes.search", "notes.create"];
```

```ts [src/capabilities/notes-search.ts]
import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  name: "notes.search",
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  effect: "read",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: {}, additionalProperties: false },
  run: async () => ({}),
});
```

A `hydration: "islands"` route that activates a page tool keeps the page bootstrap even when it renders no islands.

---

## Define the Contract

```ts [src/capabilities/notes-search.ts]
import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import { searchNotes } from "../server/notes-store.ts";

interface SearchInput {
  query: string;
  limit: number;
}

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "object" } } },
    required: ["notes"],
  },
  effect: "read",
  expose: { http: true, webmcp: true },
  async run({ input }: CapabilityRunArgs<SearchInput>) {
    return { notes: searchNotes(input.query, input.limit) };
  },
});
```

Plain JSON Schema uses pracht's dependency-free subset validator. Unsupported keywords (`oneOf`, `$ref`, `pattern`, …) are rejected at definition time and by `pracht verify`.

If your app already has a validator that implements Standard JSON Schema, reuse it directly. Zod 4 does:

```ts [src/schemas/notes.ts]
import * as z from "zod";

export const searchInput = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).default(10),
});
export const searchOutput = z.object({ notes: z.array(z.string()) });
```

```ts [src/capabilities/notes-search.ts]
import { defineCapability } from "@pracht/capabilities";
import { searchInput, searchOutput } from "../schemas/notes.ts";
import { searchNotes } from "../server/notes-store.ts";

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  input: searchInput,
  output: searchOutput,
  effect: "read",
  expose: { http: true, webmcp: true },
  async run({ input }) {
    // Typed, defaulted, transformed, and validated by searchInput.
    return { notes: await searchNotes(input.query, input.limit) };
  },
});
```

Pracht derives draft-07 JSON Schemas for agent protocols and runs your original validator during dispatch, so async checks, transforms, and defaults work as usual.

Standard JSON Schema types `run()`'s input for you. With plain JSON Schema, annotate `run()` with `CapabilityRunArgs<Input>` and let TypeScript infer the output, or write `defineCapability<Input, Output>`. Don't pass only `defineCapability<Input>`: the output type then becomes `unknown`.

---

## Call It from Anywhere

Server-side — including private capabilities that have no `expose` at all:

```ts [src/routes/notes.tsx]
import { invokeCapability } from "@pracht/core/server";

export async function loader({ request, context, signal }) {
  const result = await invokeCapability("notes.search", { query: "roadmap" }, { request, context, signal });
  return result.ok ? result.data : { notes: [] };
}
```

`invokeCapability()` is trusted server composition. It runs the callee's validation, named middleware, `run()`, and output validation, but not app-level API middleware. A capability that composes others over HTTP or WebMCP must do its own transport-specific authorization; remote MCP adds [its own guards](/docs/agent-trust#remote-mcp-composition-is-guarded).

From the browser, `virtual:pracht/capabilities` holds only http-exposed names, endpoints, and effect classes. Capability modules never enter the client bundle:

```ts [src/islands/NoteForm.tsx]
import { callCapability, capabilities } from "virtual:pracht/capabilities";

const result = await callCapability("notes.create", { title });
// or through the generated client — dotted names become object paths:
const same = await capabilities.notes.create({ title });
```

Both make the same call. The nested client suits hand-typed names: a typo gets `Did you mean 'search'?`, and hover shows the capability's description.

TypeScript resolves the `virtual:pracht/*` declarations from `@pracht/vite-plugin/virtual`. New scaffolds include it; older apps add it next to `vite/client`:

```json [tsconfig.json]
{ "compilerOptions": { "types": ["vite/client", "@pracht/vite-plugin/virtual"] } }
```

For calls driven by interaction — a button, a search box, a picker — `useCapability()` owns the pending/error/result state:

```tsx [src/routes/notes.tsx]
import { useCapability } from "virtual:pracht/capabilities";

const search = useCapability("notes.search");

<button disabled={search.pending} onClick={() => search.call({ query })}>
  {search.pending ? "Searching…" : "Search"}
</button>;
{search.error ? <p>{search.error.message}</p> : null}
{search.data ? <p>{search.data.notes.length} found</p> : null}
```

Concurrent calls are last-one-wins, and `data` stays visible while a follow-up is pending. For data a page needs on load, call `invokeCapability()` in a `loader` instead.

Importing a capability module from client code fails the build. HTTP-exposed capabilities must declare `effect` as an inline string literal, and a custom `expose.http.path` must be a same-origin pathname starting with `/`.

A `destructive` capability is confirmation-gated. Call it with `{ prepare: true }` to get a token without running it, then repeat the identical input with `{ confirm: token }` to commit:

```ts [src/islands/PurgeButton.tsx]
import { capabilities } from "virtual:pracht/capabilities";

const prepared = await capabilities.notes.purge({ titlePrefix: "Old" }, { prepare: true });

const confirmationToken =
  !prepared.ok && prepared.error.code === "confirmation_required"
    ? prepared.error.confirmationToken
    : undefined;

if (confirmationToken) {
  await capabilities.notes.purge({ titlePrefix: "Old" }, { confirm: confirmationToken });
}
```

Full options: `{ headers, signal, prepare, confirm, revalidate }`. See [Agent Trust](/docs/agent-trust#destructive-capabilities-preparecommit) for what the server checks on each half.

`<Form>` can post straight to a capability, so the human form and the agent tool share one contract. Fields are coerced onto the input schema, and without JavaScript the endpoint redirects back:

```tsx [src/routes/notes.tsx]
import { Form } from "@pracht/core";

<Form capability="notes.create" onCapabilityResult={(result) => setStatus(result)}>
  <input name="title" />
  <button type="submit">Create note</button>
</Form>;
```

After typegen, `capability` accepts only http-exposed names. Set `action` explicitly for a capability with a custom `expose.http.path`. A root-absolute `action` gets the deploy base automatically; a button's `formaction` does not, so wrap it with `withBase()`.

After any successful non-`read` call from the browser, the active route's loader data revalidates. Opt out per call with `{ revalidate: false }`.

Over HTTP, every response uses a typed envelope, with path-scoped validation issues:

```sh
curl -X POST /api/capabilities/notes/search -H 'content-type: application/json' -d '{"query":"roadmap"}'
# { "ok": true, "data": { "notes": [...] } }
# { "ok": false, "error": { "code": "invalid_input", "issues": [{ "path": "/limit", "message": "must be <= 20" }] } }
```

A capability middleware that returns 429 produces the `rate_limited` error code on every projection, and HTTP callers keep its `Retry-After` header.

`pracht typegen` writes each capability's types, effect, and exposure into `src/pracht-capabilities.d.ts`, so every call site reads the contract from the name. The compiler then rejects:

| Mistake | Result |
| --- | --- |
| Unknown or misspelled capability name | compile error (a "did you mean" suggestion through the nested `capabilities` client) |
| Input that does not match the schema | compile error |
| Calling a private capability from the browser | compile error — it has no HTTP endpoint |
| Committing a `destructive` call without `confirm` | compile error |
| A capability name computed at runtime | compile error — assert `as HttpCapabilityName` |

A capability whose input requires nothing is callable with no argument: `capabilities.notes.stats()`. For a union of names, input must suit every member, and `prepare` or `confirm` is required if any member is `destructive`.

Without typegen, calls stay untyped. Once you adopt it, drop explicit type arguments such as `invokeCapability<Output>(…)`, re-run it after upgrading pracht, and run `pracht typegen --check` in CI.

---

## WebMCP: Tools for In-Browser Agents

With `expose.webmcp: true`, pracht registers the capability as a [WebMCP](https://webmachinelearning.github.io/webmcp/) page tool via `document.modelContext.registerTool()` on routes that activate it, and swaps tools on client navigation.

The tool's `execute()` dispatches through the HTTP projection, so the agent acts as the signed-in user while validation and policy stay server-side. It returns the capability envelope (`{ ok, data }` or `{ ok: false, error }`), and a host cancellation aborts the request.

The tool carries the capability's `title`, `description`, input schema, and a `readOnlyHint` derived from its effect. Keep `expose` and `effect` inline. Standard JSON Schemas are derived by loading the module at build time, so move a top-level edge-only import inside `run()`.

Destructive capabilities cannot be page tools. For results that include user-generated or third-party content, set `untrustedContentHint` with the options form, which registers the tool just like `webmcp: true`:

```ts
expose: {
  http: true,
  webmcp: { untrustedContent: true },
},
```

The WebMCP shim is a separate chunk that loads only in browsers with the API, on routes with page tools.

### Hosts and the origin trial

WebMCP is a W3C Community Group Draft. Chrome's origin trial covers versions 149–156, and pracht's `document.modelContext` target needs Chromium 150 or later. Polyfills such as `@mcp-b/webmcp-polyfill` work too.

Treat WebMCP as an experimental progressive enhancement. As of September 2026, no mainstream browser agent consumes page tools in production, so keep HTTP or remote MCP for agents that need a production transport.

Stable Chrome needs an [origin-trial token](https://developer.chrome.com/origintrials/) on the page, or the tools stay off. Register your origin, then emit the token from your shell's `head()`:

```ts [src/shells/app.tsx]
import { publicEnv } from "@pracht/core";

export function head() {
  return {
    meta: [{ "http-equiv": "origin-trial", content: publicEnv.PRACHT_PUBLIC_WEBMCP_OT_TOKEN }],
  };
}
```

The token is public, so the [`PRACHT_PUBLIC_` prefix](/docs/env) fits. For local testing, enable `chrome://flags/#enable-webmcp-testing` (plus `#devtools-webmcp-support` for the DevTools WebMCP pane) or fake the API — see [Testing](/docs/recipes/testing#faking-webmcp-in-the-browser).

`pracht verify` errors on invalid tool names. It warns when a page tool can never work (under a `"require"` agent policy) or its metadata exceeds [Chrome's budgets](https://developer.chrome.com/docs/ai/webmcp/secure-tools): 30 characters per name, 500 per tool description, 150 per parameter description.

Chrome also recommends at most 1.5K characters per result. Pracht never truncates one, so bound output with input limits, pagination, and output-schema limits.

Page tools are restricted to their own origin. Standalone hosts can widen that with `registerWebmcpTools(..., { exposedTo: [...] })`; list only secure origins you fully trust.

---

## Remote MCP: Tools for Agents Without a Browser

Remote MCP serves the same operations to agents that never open a browser, such as a coding assistant or a scheduled workflow. It needs two opt-ins: an endpoint, and `expose.mcp` on each capability.

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

`pracht dev` prints the endpoint. `pracht verify` warns when `expose.mcp` has no endpoint to serve it.

A custom `path` must be a same-origin pathname starting with `/`, and must not match a capability HTTP path, an API route, or a page route. `/mcp` and `/mcp/` reach the same endpoint; with `auth`, any spelling other than `resource` is redirected to it with `308`.

`expose.mcp` does not require `expose.http`. A `destructive` capability needs a third opt-in — see [Destructive Tools](#destructive-tools). MCP tools need input and output schemas with an `{ type: "object" }` root.

Remote MCP needs a request runtime, so `@pracht/adapter-static` rejects `agents.mcp`.

> [!NOTE]
> `pracht dev-mcp` is a different thing entirely: a stdio server that gives *coding* agents access to your app graph while you build. This section is about your deployed app's own tools. See [Coding Agents](/docs/coding-agents).

### A Transport, Not a Second Pipeline

`tools/call` builds the request the HTTP projection would have received and hands it to the same dispatch `/api/capabilities/*` uses:

```text
POST /mcp
  → transport checks (method, Accept, Origin, protocol version)
  → tools/list  = projection of the resolved capability graph
  → tools/call  = the capability HTTP dispatch, verbatim
```

Validation, middleware, `agentPolicy`, and auditing are identical across HTTP, WebMCP, and MCP. Nested `invokeCapability()` calls under MCP re-apply the callee's `agentPolicy` and refuse destructive callees unless the served tool already cleared prepare/commit. See [Remote MCP Composition Is Guarded](/docs/agent-trust#remote-mcp-composition-is-guarded).

The endpoint is stateless (no sessions or server→client streams), so it runs unchanged on the Node, Cloudflare, Netlify, and Vercel adapters.

### What an Agent Sees

`tools/list` projects the capability's own JSON Schemas:

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

Annotations are UX hints; the server enforces the effect class. `write` capabilities omit `destructiveHint`, and `destructive` ones set it to `true`.

Dots in names become underscores: `notes.search` becomes `notes_search`. Names that collide after that mapping, or exceed 64 characters, fail `pracht verify`, and the endpoint answers every call with an error until you rename them.

Results carry both the validated output and a text rendering, for hosts that only read text:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"notes\": [ … ] }" }],
  "structuredContent": { "notes": [/* … */] },
  "isError": false
}
```

An unknown tool or malformed params is a JSON-RPC `error`, sent with HTTP 200. A validation failure, middleware rejection, or policy denial is an `isError: true` result with the code and issues in `_meta["io.pracht/error"]`. Non-2xx statuses mean transport failures.

### Destructive Tools

Off by default. A `destructive` capability that sets `expose.mcp` is left out of `tools/list` and `tools/call` until you turn on two things:

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

Middleware applied to the capability or the app's API chain may import the setup instead. The store is required because the agent that receives the token also commits it; the store makes each token single-use. See [Durable Approvals](/docs/agent-trust#durable-approvals).

If the store, `PRACHT_CONFIRMATION_SECRET`, or (in `mode: "human"`) a principal source is missing, the whole endpoint answers an error naming what is missing instead of serving tools. A principal source is a Web Bot Auth key or directory, or a principal resolver.

`pracht verify` warns when it finds no `setCapabilityApprovalStore()` call in your source directories.

#### Prepare and Commit over `tools/call`

The flow is [the same one HTTP uses](/docs/agent-trust#destructive-capabilities-preparecommit). The token is bound to a hash of `arguments`, so it travels in `_meta` instead:

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

A tampered, expired, or replayed token answers `confirmation_invalid`; in `mode: "human"` the commit answers `confirmation_pending` until a person decides. Each descriptor advertises `_meta["io.pracht/confirmation"] = { required: true, metaKey: "io.pracht/confirmation" }` for hosts.

### Transport Security

- **Cookie-bearing requests get 403**, so a browser session never authenticates remote MCP. `Authorization` is forwarded to your middleware.
- **Browser requests get 403**: any request with an `Origin` or `Sec-Fetch-Site` header.
- **Destructive capabilities are unreachable without the opt-in**, even through composition.

Every dispatch audits with `transport: "mcp"`, and composed calls with `via: "mcp"`. See [Audit Trail](/docs/agent-trust#audit-trail).

Without `agents.mcp.auth`, the endpoint is open and authentication belongs in named middleware. With it, the endpoint is an OAuth 2.0 protected resource.

### OAuth: Letting a Real Host Connect

MCP hosts such as Claude, ChatGPT connectors, and Inspector authenticate through the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). Pracht implements its resource-server half: [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata and an [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) `WWW-Authenticate` challenge. Token issuance and consent stay with your identity provider.

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

`verify` is a module reference so the verifier never reaches the client bundle. Its module must default-export a function. If two files share its path suffix, use a root-relative reference such as `() => import("/src/server/mcp-token.ts")`.

`resource` must be the exact, canonical URL of the endpoint: HTTPS (HTTP only on loopback), no query or fragment, no trailing slash. `pracht verify` names any problem in the `auth` block.

[`pracht plan`](/docs/coding-agents#the-route-graph-lockfile) flags removing a required scope, trusting another authorization server, or removing auth as a guard weakening.

#### The Metadata Document

Served unauthenticated and CORS-open at the RFC 9728 path, where the well-known segment goes *between* the host and the resource's path:

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

The bare `/.well-known/oauth-protected-resource` answers with the same document. Tokens are read only from the `Authorization` header.

**Under a deploy base, the document is still at the origin root**, with the base inside the suffix. An app whose endpoint is `https://app.example.com/app/mcp` publishes at:

```text
https://app.example.com/.well-known/oauth-protected-resource/app/mcp
```

Set `resource` to the endpoint's real deployed URL, base included. If `agents.mcp.path` is `/`, `resource` is the app root (`https://app.example.com/app` here), or the slashless `https://app.example.com` at the origin root.

#### The Challenge

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

`resource_metadata` tells a new host which authorization server to use. The check runs before the JSON-RPC body is parsed, so an unauthenticated caller learns nothing about your tools.

#### Writing `verify`

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

`jose` runs on Workers and Vercel Edge, but any library or an introspection call works too.

The hook **fails closed**: returning `null`, throwing, or returning no non-empty `subject` answers `401 invalid_token`. Thrown messages are logged, never sent to the caller. A `verify` module that fails to load answers 401 to every request, and inspection reports the endpoint `blocked`. The second argument holds a readable `request` clone.

#### The Verified Principal

The principal is bound to the request context as `context.tokenAuth`, alongside [`context.agent`](/docs/agent-trust#web-bot-auth-verified-agent-identity):

```ts
async run({ context }) {
  context.tokenAuth; // { subject, scopes?, clientId?, claims? } — frozen
}
```

It is a read-only, request-local snapshot that middleware cannot rewrite, present only on authenticated MCP requests. `claims` is frozen only at the top level. Requests answer 500 if your adapter context already has a `tokenAuth` field or is a native built-in such as `Map`; wrap one in an ordinary object.

An adapter's `createContext` hook may run before MCP authentication. Treat its request as untrusted and avoid privileged or expensive work there.

`context.agent` says *which agent software* signed the request; `context.tokenAuth` says *on whose behalf* it acts. The [audit event](/docs/agent-trust#audit-trail) records both. Apps without `auth` ship none of this code.

### Talking to It

```bash
curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"notes_search","arguments":{"query":"roadmap"}}}'
```

Protocol versions are negotiated on `initialize`, newest first: `2025-11-25`, `2025-06-18`.

For a repeatable check, a [`pracht eval`](/docs/agent-trust#the-same-scenario-over-remote-mcp) scenario with `"transport": "mcp"` drives the endpoint like a host. For a protected endpoint, add `"mcpHeaders": { "authorization": "Bearer …" }`, and keep real tokens out of committed files.

With `auth` configured, send the token. Point hosts at the endpoint, not the metadata URL:

```bash
curl -sX POST https://app.example.com/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Not built yet: an authorization server, `resources/*` and `prompts/*`, streaming and progress, and MCP Apps UI views.

---

## Private by Default

- A capability without `expose` is never reachable over the network.
- Exposure requires a complete contract — `pracht verify` fails for exposed capabilities missing a description, schema, or effect class.
- `destructive` capabilities need server-verified confirmation. They may be exposed over HTTP and [remote MCP](#destructive-tools), never as WebMCP page tools. See [Agent Trust](/docs/agent-trust).
- Output is validated too: data outside the output schema produces a redacted 500.
- HTTP-exposed capabilities are listed in the generated [`/llms.txt`](/docs/agents#llmstxt) with their endpoint, effect class, and description.

---

## Cost When Unused

Apps that register no capabilities and configure no `agents` ship no agent surface: the production build drops capability dispatch and the Web Bot Auth verifier. Development keeps them, so adding a capability needs no restart.

If the build cannot read the manifest statically (spreads, computed keys, and similar), it keeps the runtime rather than risk disabling a capability.

---

## Inspect the Graph

The capability graph feeds the `pracht dev` banner, `pracht inspect capabilities [--json]`, the `/_pracht` devtools page, the `inspect_capabilities` and `inspect_agents` tools on [`pracht dev-mcp`](/docs/coding-agents#the-authoring-mcp-server), and `pracht verify`. `pracht inspect routes` shows each route's page tools.

```sh
pracht inspect capabilities
# notes.search   read   http,webmcp,mcp   /api/capabilities/notes/search
# notes.create   write  http,mcp          /api/capabilities/notes/create
```

An MCP exposure the endpoint cannot serve shows as `mcp(unserved)`. The CLI skips your adapter's server entry, so it shows `mcp(unverified)` when a missing precondition might be registered there. JSON output includes `mcpEndpoint`, `mcpDestructive`, `mcpRuntimeStatus` (`not-configured`, `ready`, `blocked`, or `unverified`), and `mcpUnavailableReasons`.

`pracht inspect agents` summarizes `defineApp({ agents })`: Web Bot Auth, confirmation mode, the MCP endpoint and OAuth policy, `llms.txt`, and exposure counts per transport.

To see whether agents are actually calling the app, use the **Agents** panel on `/_pracht` in dev, or `addCapabilityAuditListener()` in production. See [Agent trust](/docs/agent-trust#audit-trail).

In dev, every page also registers read-only `pracht_*` WebMCP tools (route, loader data, islands, last error) for an agent driving the browser. See [Dev page tools](/docs/coding-agents#debugging-in-the-tab-dev-page-tools).

For the story behind the design, read [The Agentic Web](/docs/agents); for the identity, confirmation, and audit rules every projection enforces, read [Agent Trust](/docs/agent-trust); for unit, E2E, and WebMCP testing patterns, see the [Testing recipe](/docs/recipes/testing).
