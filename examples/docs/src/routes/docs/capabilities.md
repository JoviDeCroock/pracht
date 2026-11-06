---
title: Capabilities
lead: Define a typed operation once and call it from server code, over HTTP, as a WebMCP page tool, or as a remote MCP tool.
---

A capability is a typed application operation: JSON Schema input and output, an effect class (`read`, `write`, or `destructive`), optional named middleware, and a server-only `run()` function. From one definition pracht serves:

| Surface | Turn it on | Callers |
| --- | --- | --- |
| Direct server call | Always available | `invokeCapability()` in loaders, API routes, and middleware |
| HTTP endpoint | `expose.http` | `POST /api/capabilities/<name>`, the generated browser client, `<Form capability>` |
| WebMCP page tool | `expose.webmcp` (needs `expose.http`) and the route's `capabilities` list | An agent in the user's browser tab |
| Remote MCP tool | `expose.mcp` and `defineApp({ agents: { mcp } })` | An agent without a browser. See [Remote MCP](#remote-mcp-tools-for-agents-without-a-browser) |

Every surface runs the same pipeline:

```text
input validation → middleware chain → run() → output validation → audit event
```

## Register capabilities

Add each capability to `defineApp({ capabilities })`, like shells and middleware. Then list the page tools each route offers:

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

Both routers support capabilities. With the [pages router](/docs/routing#capabilities-via-srccapabilities), every module in `src/capabilities/` is registered automatically, and `agents` is configured in `src/pages/_app.config.ts`. Name a capability with `defineCapability({ name })` or let the filename provide it (`notes-search.ts` becomes `notes.search`). A page lists its tools in an inline `CAPABILITIES` export (not in `_app.tsx` or `404.tsx`):

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

Capability modules load on the first capability or MCP request, never for a page view.

## Define the contract

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

Plain JSON Schema runs through pracht's built-in subset validator. Unsupported keywords (`oneOf`, `$ref`, `pattern`, …) fail at definition time and in `pracht verify`.

With plain JSON Schema, type `run()` with `CapabilityRunArgs<Input>` and let TypeScript infer the output, or write `defineCapability<Input, Output>`. `defineCapability<Input>` alone makes the output type `unknown`.

A validator that implements Standard JSON Schema, such as Zod 4, can replace the plain schemas:

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

pracht derives draft-07 JSON Schemas for agent protocols and runs your validator during dispatch, so async checks, transforms, defaults, and `run()`'s input types come from it.

## Call a capability

### From server code

Call any capability, including a private one with no `expose`, with `invokeCapability()`:

```ts [src/routes/notes.tsx]
import { invokeCapability } from "@pracht/core/server";

export async function loader({ request, context, signal }) {
  const result = await invokeCapability("notes.search", { query: "roadmap" }, { request, context, signal });
  return result.ok ? result.data : { notes: [] };
}
```

`invokeCapability()` is trusted server composition: it runs the callee's validation, named middleware, `run()`, and output validation, but not app-level API middleware. A capability that calls others must do its own authorization for HTTP and WebMCP callers; remote MCP adds [its own guards](/docs/agent-trust#remote-mcp-composition-is-guarded).

### From the browser

Import the generated client from `virtual:pracht/capabilities`. It holds only HTTP-exposed names, endpoints, and effect classes:

```ts [src/islands/NoteForm.tsx]
import { callCapability, capabilities } from "virtual:pracht/capabilities";

const result = await callCapability("notes.create", { title });
// or through the generated client — dotted names become object paths:
const same = await capabilities.notes.create({ title });
```

Both make the same call; the nested client adds `Did you mean 'search'?` on typos and descriptions on hover. Importing a capability module itself from client code fails the build.

TypeScript resolves `virtual:pracht/*` from `@pracht/vite-plugin/virtual`. New scaffolds include it; older apps add it next to `vite/client`:

```json [tsconfig.json]
{ "compilerOptions": { "types": ["vite/client", "@pracht/vite-plugin/virtual"] } }
```

For calls driven by a button, search box, or picker, `useCapability()` tracks pending, error, and result state:

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

After a successful non-`read` call from the browser, the active route's loader data revalidates. Pass `{ revalidate: false }` to skip it. The full call options are `{ headers, signal, prepare, confirm, revalidate }`.

### Destructive calls

Call a `destructive` capability with `{ prepare: true }` to get a confirmation token without running it, then repeat the identical input with `{ confirm: token }` to commit:

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

[Agent trust](/docs/agent-trust#destructive-capabilities-preparecommit) covers what the server checks on each half.

### From a form

Point `<Form>` at a capability so the human form and the agent tool share one contract. Fields are coerced onto the input schema, and without JavaScript the endpoint redirects back:

```tsx [src/routes/notes.tsx]
import { Form } from "@pracht/core";

<Form capability="notes.create" onCapabilityResult={(result) => setStatus(result)}>
  <input name="title" />
  <button type="submit">Create note</button>
</Form>;
```

For a capability with a custom `expose.http.path`, set `action` explicitly. A root-absolute `action` gets the deploy base automatically; a button's `formaction` does not, so wrap it with `withBase()`.

### Over HTTP

Every response is a typed envelope, with path-scoped validation issues:

```sh
curl -X POST /api/capabilities/notes/search -H 'content-type: application/json' -d '{"query":"roadmap"}'
# { "ok": true, "data": { "notes": [...] } }
# { "ok": false, "error": { "code": "invalid_input", "issues": [{ "path": "/limit", "message": "must be <= 20" }] } }
```

A capability middleware that returns 429 produces the `rate_limited` error code on every surface, and HTTP callers keep its `Retry-After` header.

### Typed calls

Run `pracht typegen` to write each capability's types, effect, and exposure into `src/pracht-capabilities.d.ts`. Every call site then reads the contract from the name, and the compiler rejects:

| Mistake | Result |
| --- | --- |
| Unknown or misspelled capability name | compile error (a "did you mean" suggestion through the nested `capabilities` client) |
| Input that does not match the schema | compile error |
| Calling a private capability from the browser | compile error — it has no HTTP endpoint |
| Committing a `destructive` call without `confirm` | compile error |
| A capability name computed at runtime | compile error — assert `as HttpCapabilityName` |

A capability whose input requires nothing is callable with no argument: `capabilities.notes.stats()`. For a union of names, input must suit every member, and `prepare` or `confirm` is required if any member is `destructive`. After typegen, `<Form capability>` accepts only HTTP-exposed names.

Without typegen, calls are untyped. Once you adopt it, drop explicit type arguments such as `invokeCapability<Output>(…)`, re-run it after upgrading pracht, and run `pracht typegen --check` in CI.

## WebMCP: tools for in-browser agents

Set `expose.webmcp: true` and list the capability on a route. pracht registers it as a [WebMCP](https://webmachinelearning.github.io/webmcp/) page tool with `document.modelContext.registerTool()` on that route, and swaps tools on client navigation.

The tool's `execute()` calls the HTTP endpoint as the signed-in user and returns its envelope (`{ ok, data }` or `{ ok: false, error }`). A host cancellation aborts the request.

The tool carries the capability's `title`, `description`, input schema, and a `readOnlyHint` derived from its effect. Keep `expose` and `effect` as inline literals. Standard JSON Schemas are derived by loading the module at build time, so move a top-level edge-only import inside `run()`.

For results that include user-generated or third-party content, set `untrustedContentHint` with the options form, which registers the tool like `webmcp: true`:

```ts
expose: {
  http: true,
  webmcp: { untrustedContent: true },
},
```

Destructive capabilities cannot be page tools. Activating a tool is not access control: the HTTP endpoint stays reachable. Browsers without WebMCP download none of this code.

### Hosts and the origin trial

WebMCP is an experimental W3C Community Group Draft, so keep HTTP or remote MCP for production agents. Chrome's origin trial covers versions 149–156, and pracht's `document.modelContext` target needs Chromium 150 or later. Polyfills such as `@mcp-b/webmcp-polyfill` also work.

Stable Chrome needs an [origin-trial token](https://developer.chrome.com/origintrials/) on the page, or the tools stay off. Register your origin, then emit the token from your shell's `head()`:

```ts [src/shells/app.tsx]
import { publicEnv } from "@pracht/core";

export function head() {
  return {
    meta: [{ "http-equiv": "origin-trial", content: publicEnv.PRACHT_PUBLIC_WEBMCP_OT_TOKEN }],
  };
}
```

The token is public, so the [`PRACHT_PUBLIC_` prefix](/docs/env) fits. For local testing, enable `chrome://flags/#enable-webmcp-testing` (plus `#devtools-webmcp-support` for the DevTools WebMCP pane) or fake the API; see [Testing](/docs/recipes/testing#faking-webmcp-in-the-browser).

`pracht verify` errors on invalid tool names. It warns when a page tool can never work (under a `"require"` agent policy) or its metadata exceeds [Chrome's budgets](https://developer.chrome.com/docs/ai/webmcp/secure-tools): 30 characters per name, 500 per tool description, 150 per parameter description. Chrome also recommends at most 1.5K characters per result, and pracht never truncates one, so bound output with input limits, pagination, and output-schema limits.

## Remote MCP: tools for agents without a browser

Configure an endpoint in `agents.mcp`, then set `expose.mcp` on each capability it should serve:

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

`pracht dev` prints the endpoint, and `pracht verify` warns when `expose.mcp` has no endpoint to serve it. `expose.mcp` does not require `expose.http`. MCP tools need input and output schemas with an `{ type: "object" }` root. A `destructive` capability needs a third opt-in; see [Destructive tools](#destructive-tools).

A custom `path` must be a same-origin pathname that no capability, API route, or page already uses. Remote MCP needs a request runtime, so `@pracht/adapter-static` rejects `agents.mcp`.

`tools/call` uses the same dispatch as `/api/capabilities/*`, so validation, middleware, `agentPolicy`, and auditing match HTTP, and nested `invokeCapability()` calls are [guarded](/docs/agent-trust#remote-mcp-composition-is-guarded). The endpoint is stateless and runs on every serverful adapter.

> [!NOTE]
> `pracht dev-mcp` is unrelated: it gives *coding* agents your app graph during development. See [Coding agents](/docs/coding-agents).

### What an agent sees

`tools/list` projects each capability's own JSON Schemas:

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

Annotations are hints for the host; the server enforces the effect class. `tools/list` returns 100 tools per page (`agents.mcp.pageSize`) with a `nextCursor` while more remain.

Dots in names become underscores: `notes.search` becomes `notes_search`. `pracht verify` fails on names that collide after that mapping or exceed 64 characters.

Results carry the validated output and a text rendering:

```jsonc
{
  "content": [{ "type": "text", "text": "{ \"notes\": [ … ] }" }],
  "structuredContent": { "notes": [/* … */] },
  "isError": false
}
```

| Failure | Response |
| --- | --- |
| Unknown tool or malformed params | JSON-RPC `error`, sent with HTTP 200 |
| Validation failure, middleware rejection, or policy denial | `isError: true` result, with the code and issues in `_meta["io.pracht/error"]` |
| Transport failure | Non-2xx HTTP status |

### Destructive tools

A `destructive` capability with `expose.mcp` stays out of `tools/list` and `tools/call` until you turn on `agents.mcp.destructive` and register an approval store:

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

The store makes each confirmation token single-use, which matters because the agent that receives a token also commits it. See [Durable approvals](/docs/agent-trust#durable-approvals).

If the store, `PRACHT_CONFIRMATION_SECRET`, or (in `mode: "human"`) a principal source is missing, the endpoint answers every request with an error naming what is missing. A principal source is a principal resolver or `agents.mcp.auth`, not a Web Bot Auth key. `pracht verify` warns when it finds no `setCapabilityApprovalStore()` call.

#### Prepare and commit over `tools/call`

The flow is [the same one HTTP uses](/docs/agent-trust#destructive-capabilities-preparecommit), with the token in `_meta`:

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

A tampered, expired, or replayed token answers `confirmation_invalid`. In `mode: "human"` the commit answers `confirmation_pending` until a person decides. Each tool descriptor advertises `_meta["io.pracht/confirmation"] = { required: true, metaKey: "io.pracht/confirmation" }`.

### Browser and cookie requests

The endpoint answers `403` to requests that carry cookies, and to browser requests (any `Origin` or `Sec-Fetch-Site` header) unless `agents.mcp.allowedOrigins` lists that exact origin, such as `"https://inspector.example"`. Listed origins get CORS headers and authenticate with `Authorization`.

Without `agents.mcp.auth`, the endpoint is open, and authentication belongs in named middleware, which receives the `Authorization` header. With `auth`, the endpoint is an OAuth 2.0 protected resource. Every dispatch is audited with `transport: "mcp"`; see [Audit trail](/docs/agent-trust#audit-trail).

### OAuth: letting a real host connect

Add `agents.mcp.auth` so MCP hosts such as Claude, ChatGPT connectors, and Inspector can sign users in through the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). pracht is the resource server ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata, [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750) challenge); your identity provider issues tokens.

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

`resource` must be the endpoint's exact, deployed URL, including any deploy base: HTTPS (HTTP only on loopback), no query, fragment, or trailing slash. Requests to any other spelling of the endpoint are redirected to it with `308`. `pracht verify` names any problem in the `auth` block.

`verify` is a module reference, so the verifier never reaches the client bundle; its module must default-export a function. [`pracht plan`](/docs/coding-agents#the-route-graph-lockfile) flags removing a required scope, trusting another authorization server, or removing `auth` as a guard weakening.

#### The metadata document

pracht serves the metadata unauthenticated and CORS-open at the RFC 9728 path, which puts the well-known segment between the host and the endpoint's path:

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

The bare `/.well-known/oauth-protected-resource` returns the same document. Under a deploy base the document stays at the origin root, with the base inside the suffix: an endpoint at `https://app.example.com/app/mcp` publishes at `https://app.example.com/.well-known/oauth-protected-resource/app/mcp`.

#### The challenge

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

Unauthenticated callers learn nothing about your tools. With `expose: { mcp: { scopes: ["notes.write"] } }`, only tokens carrying those scopes see the tool, and calling it without them returns the `403` challenge. Scoped tools need `auth`.

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

Any JWT library or an introspection call works. A verifier that throws answers `401 invalid_token`. Its second argument holds a readable `request` clone.

#### The verified principal

Read the verified principal from `context.tokenAuth`:

```ts
async run({ context }) {
  context.tokenAuth; // { subject, scopes?, clientId?, claims? } — frozen
}
```

It is present only on authenticated MCP requests, and middleware cannot rewrite it. `context.agent` says *which agent software* signed the request ([Web Bot Auth](/docs/agent-trust#web-bot-auth-verified-agent-identity)); `context.tokenAuth` says *on whose behalf* it acts. The [audit event](/docs/agent-trust#audit-trail) records both.

### Talking to it

```bash
curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -sX POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"notes_search","arguments":{"query":"roadmap"}}}'
```

With `auth` configured, send the token. Point hosts at the endpoint, not the metadata URL:

```bash
curl -sX POST https://app.example.com/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`initialize` negotiates the protocol version, newest first: `2025-11-25`, `2025-06-18`. The endpoint serves tools only, with no `resources/*` or `prompts/*`.

For a repeatable check, a [`pracht eval`](/docs/agent-trust#the-same-scenario-over-remote-mcp) scenario with `"transport": "mcp"` drives the endpoint like a host. Protected endpoints take `"mcpHeaders": { "authorization": "Bearer …" }`; keep real tokens out of committed files.

## Private by default

- A capability without `expose` is never reachable over the network.
- `pracht verify` fails for an exposed capability missing a description, schema, or effect class.
- `destructive` capabilities need server-verified confirmation over HTTP and [remote MCP](#destructive-tools), and are never WebMCP page tools.
- Output is validated too: data outside the output schema produces a redacted 500.
- HTTP-exposed capabilities appear in the generated [`/llms.txt`](/docs/agents#llmstxt).

Apps that register no capabilities and configure no `agents` ship no agent runtime: the production build drops capability dispatch and the Web Bot Auth verifier. Development keeps both, so adding a capability needs no restart.

## Inspect the graph

Run `pracht inspect capabilities` to list every capability with its effect, transports, and endpoint:

```sh
pracht inspect capabilities
# notes.search   read   http,webmcp,mcp   /api/capabilities/notes/search
# notes.create   write  http,mcp          /api/capabilities/notes/create
```

`mcp(unserved)` marks an MCP exposure the endpoint cannot serve, and `mcp(unverified)` one the CLI cannot confirm without your adapter's server entry. `--json` adds `mcpRuntimeStatus` and `mcpUnavailableReasons`.

| Command or tool | Shows |
| --- | --- |
| `pracht inspect routes` | Each route's page tools |
| `pracht inspect agents` | Web Bot Auth, confirmation mode, the MCP endpoint and OAuth policy, `llms.txt`, and exposure counts per transport |
| `/_pracht` **Agents** panel (dev) | Live capability calls with agent attribution |
| `addCapabilityAuditListener()` (production) | Every dispatch; see [Audit trail](/docs/agent-trust#audit-trail) |
| [`pracht dev-mcp`](/docs/coding-agents#the-authoring-mcp-server) | `inspect_capabilities` and `inspect_agents` for coding agents |
| [Dev page tools](/docs/coding-agents#debugging-in-the-tab-dev-page-tools) | Read-only `pracht_*` WebMCP tools on every dev page |

For identity, confirmation, and audit rules, read [Agent trust](/docs/agent-trust). For unit, E2E, and WebMCP test patterns, see the [Testing recipe](/docs/recipes/testing).
