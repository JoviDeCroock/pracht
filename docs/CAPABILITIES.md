# Capabilities

Capabilities are typed, protocol-neutral application operations: one explicit
contract (JSON Schema input/output, an effect class, named middleware, a
server-only `run()` function) that Pracht can project into multiple surfaces.
Today those surfaces are:

- **direct server invocation** — `invokeCapability()` from loaders, API
  routes, and middleware;
- **an HTTP endpoint** — generated `POST` dispatch when `expose.http` is set;
- **a WebMCP page tool** — registered in the browser for in-page agents when
  `expose.webmcp` is set (Chrome origin trial).

Every projection calls the same validated pipeline, so business rules never
diverge between transports:

```text
input validation → named middleware chain → run() → output validation
```

Capability inputs, outputs, and schema values are restricted to the JSON data
model. JavaScript-only values such as `File`, `Blob`, `Date`, `Map`,
`undefined`, and circular objects are rejected even when a schema is otherwise
unconstrained. File uploads should stay in API routes rather than capability
contracts.

## Registration

Capabilities are registered in the app manifest, exactly like shells and
middleware. Registration is deliberately opt-in: no API route or loader is
ever inferred as a capability.

```ts
// src/routes.ts
import { defineApp } from "@pracht/core";

export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
    "notes.create": () => import("./capabilities/notes-create.ts"),
  },
  // shells, middleware, routes...
});
```

Capability modules live in `src/capabilities/` by default (configurable via
the `capabilitiesDir` plugin option). Names are dot-separated segments of
letters, numbers, hyphens, and underscores. Capabilities are manifest-mode
only for now — the pages router has no manifest to register them in.

## defineCapability

```ts
// src/capabilities/notes-search.ts
import { defineCapability } from "@pracht/capabilities";
import { searchNotes } from "../server/notes-store.ts";

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
  middleware: ["auth"], // optional — names from the app manifest
  expose: { http: true, webmcp: true }, // optional — private without it
  async run({ input, context, request, signal }) {
    return { notes: searchNotes(input.query, input.limit) };
  },
});
```

`context` defaults to `CapabilityContext`: `context.agent` is typed as the
verified Web Bot Auth identity (`PrachtAgentIdentity | null`, absent when
`agents` is not configured — see [AGENT_TRUST.md](AGENT_TRUST.md)), and
everything middleware attaches is reachable as `unknown`. Narrow it with your
own type via the third generic (`defineCapability<In, Out, MyContext>`), or
use the framework's `PrachtRequestContext` for the app-registered context.

### Schemas

`input` and `output` are plain JSON Schema objects validated by a
dependency-free subset validator (no ajv/zod in your server or client
bundles). Supported keywords:

`type` (`object`/`array`/`string`/`number`/`integer`/`boolean`/`null`),
`properties`, `required`, `additionalProperties`, `items` (single schema),
`enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `default`
(applied to input before validation), plus the `title` and `description`
annotations.

Anything else — `oneOf`, `anyOf`, `allOf`, `$ref`, `pattern`, `format`,
tuple-form `items`, array `type` unions, and the rest of full JSON Schema —
is **rejected**: `defineCapability()` throws at definition time and
`pracht verify` fails, naming the offending keyword. A keyword the validator
would silently ignore could otherwise widen what an exposed capability
accepts.

Validation errors are path-scoped (`{ path: "/limit", message: "must be <= 20" }`)
so humans and agents can pinpoint what to fix.

### Effects

Every capability declares one of `read`, `write`, or `destructive`.
Destructive capabilities (delete, publish, pay, send, change access) may be
exposed over HTTP only, and every dispatch is gated by a server-verified
prepare/commit confirmation flow that requires `PRACHT_CONFIRMATION_SECRET`
to be configured — optionally backed by a durable approval store for
exactly-once commits and human approval, see
[AGENT_TRUST.md](AGENT_TRUST.md). Exposing them to
agent projections (`expose.webmcp`/`expose.mcp`) stays disallowed:
`defineCapability()`, the runtime registry, and `pracht verify` all enforce
this.

## Invocation

### Server-side

```ts
import { invokeCapability } from "@pracht/core/server";

export async function loader({ request, context, signal }: LoaderArgs) {
  const result = await invokeCapability<{ notes: Note[] }>(
    "notes.search",
    { query: "roadmap" },
    { request, context, signal },
  );
  if (!result.ok) {
    // result.error: { code, message, issues? }
  }
  return result.ok ? result.data : { notes: [] };
}
```

Direct invocation works for private capabilities too and runs the full
pipeline, including the capability's middleware. It is available while
`handlePrachtRequest()` is serving requests (loaders, API routes,
middleware). App-level `api.middleware` is HTTP policy and does not run for
direct invocation.

### HTTP projection

With `expose.http` set, the capability is dispatched at
`POST /api/capabilities/<name-with-dots-as-slashes>` (e.g. `notes.search` →
`/api/capabilities/notes/search`), or at a custom `expose.http.path`. Dispatch
happens in the framework's request handler, so every adapter (Node,
Cloudflare, Vercel) gets it without adapter changes. Explicit files in
`src/api/` take precedence on path collisions.

The app-level API middleware configured with
`defineApp({ api: { middleware: [...] } })` wraps every matched capability HTTP
endpoint before request parsing and before the capability's own middleware.
This keeps centralized authentication, authorization, rate limiting, and
custom CSRF policy consistent across explicit and generated API endpoints.

Custom paths must be exact same-origin pathnames beginning with `/`. Protocol-
relative URLs, backslashes, dot-segment normalization, query strings, and
fragments are rejected so the generated browser client can never reinterpret
an endpoint as cross-origin.

Requests and responses use a typed envelope:

```jsonc
// 200
{ "ok": true, "data": { ... } }
// 400 invalid input (path-scoped issues), 401/403 from middleware,
// 404 unknown capability, 405 non-POST, 500 internal
{ "ok": false, "error": { "code": "invalid_input", "message": "...", "issues": [ ... ] } }
```

Internal error details and output-schema violations are redacted in
production; invalid `run()` output is always a 500 and never returned raw.
State-changing capability calls enforce the same same-origin CSRF policy as
API routes (`api.requireSameOrigin`, on by default).

The wire contract has one home: `@pracht/capabilities` exports the path
formula (`capabilityHttpPath`), the confirmation, transport, effect, and
enhanced-form redirect header names, the envelope types, and the full
`CapabilityErrorCode` union (`CAPABILITY_ERROR_CODES`) — the framework
runtime, the generated client modules, and the CLI all import from it, so the
protocol cannot drift between packages.

### Browser

```ts
import { callCapability, capabilities } from "virtual:pracht/capabilities";

const result = await callCapability("notes.create", { title });
// or, through the generated client — dotted names become object paths:
const same = await capabilities.notes.create({ title });
```

Both forms take the identical path (endpoint table, settled event,
revalidation); `capabilities` is a nested view of the same call. Before typegen,
both keep permissive fallbacks: names and inputs are unchecked, and the nested
client's output defaults to `unknown` (or an explicit result type argument).
Once `pracht typegen` has run, both infer input and output from the capability
name, private capabilities are absent, and a `destructive` capability must
explicitly prepare for a token or provide that token to commit.

Prefer the nested client when you are typing a name by hand: its members are
real property accesses, so a typo gets `Did you mean 'search'?`. A string
literal argument to `callCapability` gets no such suggestion — it is answered
with the list of names that would have worked instead. A `destructive` name is
absent from that list until the call carries `prepare` or `confirm`, which is
how the confirmation gate shows up at a call site that forgot it.

Once typegen has run, neither form accepts a name computed at runtime. When a
name genuinely comes from data, assert it (`name as HttpCapabilityName`) and
handle the `unknown_capability` envelope the runtime still returns.

`virtual:pracht/capabilities` is generated at build time from the manifest and
contains only http-exposed capability names, endpoints, and effect classes —
capability modules themselves are server-only and never enter the client graph.
Apps without capabilities ship zero extra bytes, and the `capabilities` client
is tree-shaken away when only `callCapability` is imported.

Importing a capability module from client code is a build error. Nothing strips
one the way a route loader is stripped, so the import would bundle `run()` and
everything it pulls in — a database client, an API key — for every visitor. Call
the capability instead.

What crosses to the browser is deliberately narrow, and guarded in both
directions by tests:

| Stays server-side | Reaches the browser |
| --- | --- |
| `run()` bodies and anything they import | capability name |
| input/output JSON Schemas | HTTP endpoint path and method |
| `title` and `description` prose | effect class (it drives revalidation) |
| private capabilities — not even their names | — |

The one exception is `expose.webmcp`: an in-page agent cannot call a tool
without its schema, so webmcp-exposed capabilities ship their description and
input schema in the separate `virtual:pracht/webmcp` chunk, which only loads
when the browser exposes the WebMCP API. Nothing else does. Titles and
descriptions of other capabilities appear only as JSDoc in the generated
`.d.ts`, which is types-only and never emitted.

For a call driven by user interaction — a button, a search box, a picker —
`useCapability()` owns the pending/error/result state so components do not
hand-roll it:

```tsx
import { useCapability } from "virtual:pracht/capabilities";

function NoteSearch() {
  const search = useCapability("notes.search");

  return (
    <>
      <button disabled={search.pending} onClick={() => search.call({ query: "roadmap" })}>
        {search.pending ? "Searching…" : "Search"}
      </button>
      {search.error ? <p>{search.error.message}</p> : null}
      {search.data ? <p>{search.data.notes.length} found</p> : null}
    </>
  );
}
```

`call()` takes the same arguments as `callCapability` minus the name and
resolves to the same envelope, so you can also branch at the call site.
`reset()` clears the state. Concurrent calls are last-one-wins — an earlier
response arriving after a later one is discarded, so a search box cannot render
a stale result — and `data` stays visible while a follow-up call is `pending` or
fails. Switching the capability name starts a fresh state generation, including
when switching away and back to the original name. A retained `call` or `reset`
from an older generation cannot cancel the current generation's request, and a
malformed custom-dispatch result clears `pending` before it is surfaced.

Discarding a response is not the same as cancelling a request. `reset()`, a
newer call, and a name change all abandon the *result* — the HTTP request keeps
running to completion. A search box that calls on every keystroke will have as
many requests in flight as the user has typed, so pass a `signal` when that
matters:

```tsx
const controller = useRef<AbortController>();
controller.current?.abort();
controller.current = new AbortController();
search.call({ query }, { signal: controller.current.signal });
```

> **It dispatches when called, never during render.** For data a page needs on
> load, run the capability in a `loader` with `invokeCapability()`: that result
> is server-rendered into the HTML and revalidates automatically after
> non-`read` calls. A render-time fetch would add a client-side waterfall and
> render nothing during SSR.

Options: `{ headers, signal, confirm, revalidate }`. After a successful
non-`read` call the active route's data revalidates automatically — the effect
class the capability already declares drives the client cache; pass
`revalidate: false` to opt a call out.

Destructive capabilities take one more, `prepare`, and it is the odd one out:
it is a **compile-time marker, not a request option**. Nothing is sent for it
and no runtime behaviour depends on it. The types accept a destructive call
only with exactly one of `{ prepare: true }` or `{ confirm }`, so the two
phases of the flow have to be written out rather than inferred from an absent
argument:

```ts
const prepared = await callCapability("notes.purge", input, { prepare: true });
// -> 409 confirmation_required, carrying the token
await callCapability("notes.purge", input, {
  confirm: prepared.error.confirmationToken,
});
```

The prepare call is, on the wire, simply a call without a confirmation header —
the marker records the caller's intent for the compiler. The guarantee that it
cannot run the operation is the server's: the gate rejects an unconfirmed
destructive call before `run()`, and fails closed with `confirmation_unavailable`
when no `PRACHT_CONFIRMATION_SECRET` is configured. See
[AGENT_TRUST.md](AGENT_TRUST.md).

### Forms

The framework's `<Form>` posts directly to a capability, so the human form
and the agent tool literally share one contract:

```tsx
import { Form } from "@pracht/core";

<Form capability="notes.create" onCapabilityResult={(result) => { ... }}>
  <input name="title" />
  <button type="submit">Create</button>
</Form>;
```

- `capability` accepts only http-exposed capability names once typegen has run
  — a private one has no endpoint to post to, so naming it is a compile error
  rather than a 404 at submit time. That also rules out `capability={someString}`;
  assert with `as HttpCapabilityName` (exported from `@pracht/core`) when the
  name is genuinely dynamic.
- Fields are coerced onto the capability's input schema server-side (numbers
  parsed, checkbox `on` → boolean, repeated fields → arrays), then validated
  like any other call.
- After a successful submission the route's loader data revalidates
  automatically; `onCapabilityResult` receives the typed envelope (inferred
  from the capability name once typegen has run).
- Progressive enhancement: without JavaScript the endpoint accepts the
  form-encoded post and answers a successful document submission with a 303
  back to the same-origin referring page. Failed posts keep the JSON envelope.
- For capabilities with a custom `expose.http.path`, set `action` explicitly.
- Submit buttons can override that target with `formaction`; enhanced and
  no-JavaScript submissions resolve the same endpoint.
- Redirects returned by capability middleware (for example, an authentication
  redirect to a login page) navigate normally in enhanced forms, including
  cross-origin OAuth/SSO destinations. Pracht returns the redirect target to
  the same-origin form fetch and lets the browser navigate, so the external
  page is never fetched through CORS. Relative `Location` values resolve
  against the capability endpoint, matching native HTTP redirect behavior.

## Generated types

`pracht typegen` (the same command that generates typed routes) also emits
`src/pracht-capabilities.d.ts` when the app registers capabilities: each
capability's input/output types generated from its JSON Schemas, plus its
effect class and exposure, registered on `Register["capabilities"]`. With that
file in the program, `invokeCapability()`, the browser's `callCapability()`,
the generated `capabilities` client, `<Form capability>`, and
`createCapabilityTestHost().invoke()` all read the contract from the capability
name — no per-call generics:

```ts
const result = await invokeCapability("notes.search", { query: "roadmap" }, args);
// result.data: { notes: Array<...> } — inferred from the output schema
```

What the compiler enforces once the file exists:

| Mistake | Result |
| --- | --- |
| Unknown or misspelled capability name | compile error (a "did you mean" suggestion only through the nested `capabilities` client) |
| Input that does not match the schema | compile error |
| Calling a private capability from the browser | compile error — no HTTP endpoint exists |
| Calling a `destructive` capability without `prepare` or `confirm` | compile error (the name is reported as outside the set callable without one) |
| Passing a capability name computed at runtime | compile error — assert `as HttpCapabilityName` |

A capability whose input schema requires nothing is callable with no argument
at all: `callCapability("notes.stats")`.

- An input property is optional when it is not `required` **or** declares a
  schema `default` (defaults are applied before input validation); an output
  property is optional exactly when it is not `required`.
- Objects without `additionalProperties: false` keep an index signature, so
  extra members remain reachable as `unknown`. Extra properties on a closed
  schema are rejected at runtime with a path-scoped 400; TypeScript's
  excess-property check does not reliably reach through the generated types, so
  do not rely on it to catch them.
- Apps that have not run typegen keep the untyped
  `invokeCapability<Output>(name, ...)` form and accept any capability name.
  Once the generated registration exists that form no longer applies — even
  when removing the last capability rewrites it to an empty map. That is what
  makes stale names fail the build instead of falling through to a runtime 404.
  Drop the explicit type argument and let inference do the work; runtime
  validation is unchanged either way.
- A name typed as a union accepts only input valid for every possible member.
  Narrow the name before calling when the schemas differ; otherwise an input
  for one member could be dispatched under another member's runtime name.
- Typegen reads capability metadata by loading the modules, while the browser
  projection is built by static analysis. Typegen cross-checks the two and
  fails when they disagree, so generated types can never promise an endpoint
  the client bundle does not register.
- The confirmation gate closes whenever `destructive` is *possible*: a name
  typed as a union of capabilities demands an explicit prepare marker or token
  if any member is destructive, as does a capability whose effect the build
  could not read.
- A declaration file generated before `effect`/`exposed` existed keeps working
  unchanged, but gets none of the exposure or confirmation checks. Re-run
  `pracht typegen` (and `--check` in CI) after upgrading.
- `--capabilities-out` overrides the output path, `--check` covers the file in
  CI, and removing the last capability rewrites an existing file to the empty
  registration instead of leaving it stale. The empty registration keeps the
  typed APIs closed; it is distinct from never having run typegen.

## WebMCP

With `expose.webmcp: true` (which requires `expose.http`), the client runtime
registers the capability as a WebMCP page tool for in-browser agents. The
shim targets the Chrome origin-trial API — `document.modelContext.registerTool()`
(Chrome 150+, with the deprecated `navigator.modelContext` as a fallback):

- one tool per capability: `name`, `description`, `inputSchema` (the
  capability's JSON Schema), `annotations.readOnlyHint` from the effect;
- `execute()` calls the HTTP projection via `callCapability`, so the user's
  session authenticates the call and validation, middleware, and policy all
  stay server-side — the agent acts as the signed-in user, in their tab;
- the shim lives in its own chunk (`virtual:pracht/webmcp`) behind feature
  detection: browsers without the API never download it, and pages without
  webmcp-exposed capabilities never reference it;
- works in full-hydration and islands modes (the islands bootstrap pulls the
  shim in too; `hydration: "none"` pages ship no JS and register no tools).

If WebMCP does not graduate from its origin trial, the shim is deletable
without touching the capability contract.

### Build-time extraction constraint

The browser modules are generated by static analysis: a capability's `expose`,
the `effect` of every HTTP-exposed capability, and (for webmcp-exposed
capabilities) `input` must be **inline literals** — not imported constants or
spreads. `effect` must be an inline `"read"`, `"write"`, or `"destructive"`
string; `expose` and `input` must be inline object literals (primitive or array
`expose` values are invalid). Violations fail the build with a pointer to the
file, and `pracht verify` reports the same projection constraints.

## Security defaults

- **Private by default** — a capability without `expose` is never reachable
  over the network.
- **Shared API policy** — every HTTP-exposed capability runs app-level
  `api.middleware` first, then its capability-specific middleware. Direct
  server invocation runs only the capability-specific chain.
- **Exposure requires a complete contract** — `pracht verify` fails for
  exposed capabilities missing a description, input schema, output schema, or
  effect classification.
- **`destructive` is confirmation-gated** — HTTP exposure requires the
  prepare/commit confirmation flow (and its secret); `webmcp`/`mcp` exposure
  is an error. See [AGENT_TRUST.md](AGENT_TRUST.md).
- **Verified agent identity and policy** — Web Bot Auth (RFC 9421) puts
  `context.agent` on every request when enabled; capability endpoints can
  `agentPolicy: "require"` verified agents, and every dispatch emits an
  audit event. See [AGENT_TRUST.md](AGENT_TRUST.md).
- **Output is validated** — a handler returning data outside its output
  schema produces a redacted 500, never the raw value.
- **Same-origin enforcement** — cross-origin browser POSTs are rejected by
  default, matching API-route CSRF policy.
- **Fail closed** — a capability registry that cannot resolve (bad module,
  duplicate paths, unknown middleware) answers capability requests with 500
  and never partially serves.

## Inspection

The capability graph feeds every existing inspection surface:

- the `pracht dev` startup banner prints a Capabilities table (name, effect,
  exposure, dispatch path) whenever the app registers any;
- `pracht inspect capabilities [--json]` — name, effect, transports, HTTP
  path, middleware, source, plus the input/output JSON Schemas in `--json`
  output;
- the `/_pracht` devtools page gains a Capabilities table (dev only, rendered
  only when capabilities exist);
- the `pracht mcp` server exposes an `inspect_capabilities` tool;
- `pracht verify` runs the static contract checks described above.

## Testing agent flows

`createCapabilityTestHost()` (from `@pracht/core`) runs the dispatch pipeline
in-process for unit tests — no manifest, no Vite, no server. `invoke()`
mirrors `invokeCapability()`; `request()` mirrors the HTTP projection,
including Web Bot Auth policy (inject a simulated identity via the `agent`
option) and the destructive prepare/commit confirmation flow (set
`PRACHT_CONFIRMATION_SECRET` or call `setCapabilityConfirmationSecret()` in
test setup). See `packages/framework/test/capability-test-host.test.ts` for
worked examples.

`pracht eval` runs scripted scenarios (search → validation failure →
confirmation flow) against the capability HTTP projection and exits 1 on any
failed expectation — `--start "<command>"` launches and stops the app itself.
See [AGENT_TRUST.md](AGENT_TRUST.md#pracht-eval-scripted-agent-task-scenarios)
and `examples/basic/evals/notes.eval.json`.

## Not built yet

- Remote MCP projection (`/mcp` Streamable HTTP endpoint) and `expose.mcp`
  (accepted and recorded in the graph, but nothing serves it yet —
  `pracht verify` warns and the dev banner shows it as `mcp(unserved)` so a
  declared-but-dead transport is never mistaken for a live one).
- MCP Apps UI (`ui` option) — `hasUi` is always `false` in the graph.
- Destructive capabilities over WebMCP/MCP (HTTP-only, confirmation-gated —
  see [AGENT_TRUST.md](AGENT_TRUST.md)).
- Capability scaffolding (`pracht generate capability`).
- Pages-router support.
