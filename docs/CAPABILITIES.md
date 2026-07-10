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
to be configured — see [AGENT_TRUST.md](AGENT_TRUST.md). Exposing them to
agent projections (`expose.webmcp`/`expose.mcp`) stays disallowed:
`defineCapability()`, the runtime registry, and `pracht verify` all enforce
this.

## Invocation

### Server-side

```ts
import { invokeCapability } from "@pracht/core";

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
middleware).

### HTTP projection

With `expose.http` set, the capability is dispatched at
`POST /api/capabilities/<name-with-dots-as-slashes>` (e.g. `notes.search` →
`/api/capabilities/notes/search`), or at a custom `expose.http.path`. Dispatch
happens in the framework's request handler, so every adapter (Node,
Cloudflare, Vercel) gets it without adapter changes. Explicit files in
`src/api/` take precedence on path collisions.

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

### Browser

```ts
import { callCapability } from "virtual:pracht/capabilities";

const result = await callCapability<{ note: Note }>("notes.create", { title });
```

`virtual:pracht/capabilities` is generated at build time from the manifest and
contains only http-exposed capability names and endpoints — capability modules
themselves are server-only and never enter the client graph (guarded by e2e
bundle assertions). Apps without capabilities ship zero extra bytes.

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

The browser modules are generated by static analysis: a capability's `expose`
and (for webmcp-exposed capabilities) `input` must be **inline object
literals** — not imported constants or spreads. Violations fail the build
with a pointer to the file, and `pracht verify` warns when a schema cannot be
analyzed statically.

## Security defaults

- **Private by default** — a capability without `expose` is never reachable
  over the network.
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
  path, middleware, source;
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
  (accepted and recorded in the graph, but nothing serves it yet).
- MCP Apps UI (`ui` option) — `hasUi` is always `false` in the graph.
- Destructive capabilities over WebMCP/MCP (HTTP-only, confirmation-gated —
  see [AGENT_TRUST.md](AGENT_TRUST.md)).
- Generated TypeScript types from schemas (`pracht typegen` integration) and
  capability scaffolding (`pracht generate capability`).
- Pages-router support.
