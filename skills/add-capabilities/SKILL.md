---
name: add-capabilities
version: 1.0.2
description: |
  Expose an app operation as a typed pracht capability — one contract projected
  into direct server calls, an HTTP endpoint, a WebMCP page tool, and a remote MCP
  tool — plus `defineApp({ agents })` trust config, typed clients,
  `<Form capability>`, and `pracht eval` scenarios.
  Use for "add a capability", "expose this to agents", "add an MCP tool", "add
  WebMCP", "serve remote MCP", "make my app agent-callable".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Capabilities

A capability is a protocol-neutral operation (`docs/CAPABILITIES.md`). Every
projection runs the identical pipeline, so rules never diverge per transport:

```text
input validation → named middleware chain → run() → output validation
```

Registration is opt-in and private by default: no loader or API route is ever
inferred as a capability, and an app that registers none ships no capability
dispatch surface (the build drops ~15 KB gzip of dispatch and verifier code).
Other agent-facing surfaces such as `llms.txt` remain independent.

## Step 1: Decide the contract before writing code

Settle these with `AskUserQuestion` when the request is vague:

- **Name** — dot-separated segments (`notes.search`); this is the agent-visible
  identity and the MCP tool name (dots become underscores).
- **Effect** — `read`, `write`, or `destructive`. This drives confirmation
  gating, client revalidation, and MCP annotations. Classify honestly.
- **Exposure** — private (omit `expose`), `http`, `webmcp` (requires `http`),
  `mcp`. Capabilities are manifest-router only; the pages router has no
  manifest to register them in.
- **Authorization** — which named middleware runs, and whether the endpoint
  requires a verified agent (`agentPolicy: "require"`).

Exposure matrix the runtime, `defineCapability()`, and `pracht verify` all
enforce:

| Effect | `http` | `webmcp` | `mcp` |
| ------ | ------ | -------- | ----- |
| `read` / `write` | yes | yes (needs `http`) | yes (needs `agents.mcp`) |
| `destructive` | yes — always confirmation-gated | rejected | yes — needs `agents.mcp.destructive` **and** a registered approval store |

## Step 2: Install and scaffold

`create-pracht` does not add the package, because an app without capabilities
should not carry it:

```bash
npm install @pracht/capabilities
pracht generate capability --name notes.search --effect read --expose http,webmcp \
  --description "Find notes whose title or body matches the query."
```

The generator writes `src/capabilities/notes-search.ts` with `expose`,
`effect`, and `input` as inline literals and registers the name in the
manifest. `--description` is required whenever `--expose` is set — that text is
the contract an agent reads. It refuses the combinations the runtime rejects
anyway. The MCP `generate_capability` tool does the same thing.

If dispatch answers `500 internal_error` and `pracht inspect capabilities`
prints capabilities as `unreadable`, the package is missing — that is the
symptom.

## Step 3: Write the capability

```ts
// src/capabilities/notes-search.ts
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
  middleware: ["auth"],            // names from the app manifest
  expose: { http: true, webmcp: true },
  // agentPolicy: "require",       // verified Web Bot Auth agents only
  async run({ input, context, request, signal }: CapabilityRunArgs<SearchInput>) {
    return { notes: searchNotes(input.query, input.limit) };
  },
});
```

Schema rules that bite:

- Only a **subset** of JSON Schema is accepted: `type`, `properties`,
  `required`, `additionalProperties`, `items` (single schema), `enum`, `const`,
  `minimum`, `maximum`, `minLength`, `maxLength`, `default`, plus `title` and
  `description`. `oneOf`, `anyOf`, `allOf`, `$ref`, `pattern`, `format`, and
  tuple `items` throw at definition time — a keyword the validator would ignore
  could widen what an exposed capability accepts.
- Inputs and outputs are JSON data only. `File`, `Blob`, `Date`, `Map`,
  `undefined`, and cycles are rejected — keep uploads in API routes.
- `expose`, `effect`, and (for webmcp) `input` must be **inline literals**: the
  browser projection is built by static analysis, and an imported constant or
  spread fails the build.
- MCP exposure additionally requires both schemas rooted at `type: "object"`.
- Annotate `run()` with `CapabilityRunArgs<Input>` so TypeScript still infers
  the output; `defineCapability<Input>` alone leaves the output `unknown`.

## Step 4: Register it, and configure `agents` only if needed

```ts
// src/routes.ts
export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
  },
  agents: {
    // Verified agent identity (public keys — safe in the manifest).
    webBotAuth: { policy: "observe", directories: ["https://signature-agent.cloudflare.com"] },
    // Destructive prepare/commit tuning.
    confirmation: { ttlSeconds: 120 },
    // Remote MCP endpoint; without this, `expose.mcp` serves nothing.
    mcp: { serverInfo: { name: "notes", version: "1.0.0" }, instructions: "…" },
  },
  routes: [/* … */],
});
```

Each `agents` sub-option is independent — add only what the app uses. Web Bot
Auth `policy: "require"` gates capability HTTP endpoints (not pages or API
routes) with `401 agent_required`; `agentPolicy: "require"` on a capability
fails closed even when `webBotAuth` is unconfigured.

## Step 5: Destructive capabilities

`destructive` (delete, publish, pay, send, change access) may be exposed over
`http` and `mcp`, never `webmcp`, and every dispatch is gated:

1. Set `PRACHT_CONFIRMATION_SECRET` in the server environment (or call
   `setCapabilityConfirmationSecret()` from `@pracht/core/server`). Without it,
   calls fail closed with `403 confirmation_unavailable` and `pracht verify`
   fails — verify reads the environment, so the variable must be set even when
   the app registers the secret programmatically.
2. A call without a token answers `409 confirmation_required` with a token
   bound to principal + capability + canonical input + expiry.
3. The commit repeats the call with byte-identical input plus the confirmation
   header.

Be honest about what this buys, and say so to the user
(`docs/AGENT_TRUST.md`): stateless HMAC cannot prevent replay inside the TTL,
the calling agent can hand the token straight back to itself, and without Web
Bot Auth or `setCapabilityApprovalPrincipalResolver()` both phases run as
`"anonymous"`. Register a `CapabilityApprovalStore` for exactly-once commits,
and `confirmation: { mode: "human" }` for a real human decision — that mode
fails closed without both a store and an authenticated principal.

`createSqlApprovalStore({ execute })` from `@pracht/core/server` is the
first-party durable store — no driver dependency, one implementation for
Postgres, Cloudflare D1, and SQLite/Turso. Pass a parameterized-query function
and run the migration from `docs/AGENT_TRUST.md`; use `dialect: "postgres"` for
`$1` placeholders. `createMemoryApprovalStore()` is for tests and development
only. A non-SQL backend needs atomic conditional writes (Durable Objects,
Redis — not Cloudflare KV).

### Destructive over remote MCP

Off by default. To serve one:

1. `agents: { mcp: { destructive: true } }` in `defineApp()`.
2. Register an approval store from a server entry or a capability module, so it
   exists before the graph is served. This is not optional — the endpoint
   answers a JSON-RPC error and `pracht verify` fails without it, because a
   token handed to the committing agent must be consumable exactly once.
3. The flow is unchanged; only the channel differs. Prepare answers
   `isError: true` with the token in `_meta["io.pracht/error"]`, and the commit
   repeats `tools/call` with identical `arguments` plus
   `_meta["io.pracht/confirmation"]`.

Nested `invokeCapability()` under an MCP tool still refuses destructive callees
unless the tool being served is a destructive capability that already cleared
prepare/commit.

## Step 6: Call it

```ts
// Server: loaders, API routes, middleware — works for private capabilities too.
import { invokeCapability } from "@pracht/core/server";
const result = await invokeCapability("notes.search", { query: "roadmap" }, { request, context, signal });
```

```ts
// Browser: generated, typed, http-exposed names only.
import { capabilities, useCapability } from "virtual:pracht/capabilities";
const result = await capabilities.notes.search({ query: "roadmap" });
```

```tsx
// One contract for the human form and the agent tool.
<Form capability="notes.create" onCapabilityResult={(result) => { /* … */ }}>
  <input name="title" />
  <button type="submit">Create</button>
</Form>
```

- Prefer a loader + `invokeCapability()` for data a page needs on load;
  `useCapability()` dispatches on interaction, never during render.
- After a successful non-`read` call the route's data revalidates
  automatically (`revalidate: false` opts out).
- Capability modules are server-only: importing one from client code is a build
  error, because nothing would strip `run()` and its database client out of the
  browser bundle.

## Step 7: Types, inspection, and proof

```bash
pracht typegen                 # emits src/pracht-capabilities.d.ts
pracht inspect capabilities --json
pracht verify --json           # contract, exposure, and projection checks
pracht eval --start "pracht preview"
```

Once the declaration exists the compiler rejects unknown names, bad input,
browser calls to private capabilities, destructive calls without
`prepare`/`confirm`, and runtime-computed names (assert
`as HttpCapabilityName`). Re-run `pracht typegen --check` in CI.

`pracht eval` runs JSON scenarios against the live app and exits 1 on a failed
expectation — the repeatable answer to "can an agent actually finish this
task?". Steps can reference earlier results
(`$steps[0].error.confirmationToken`) and a scenario-level `signAs` block signs
every step as a verified agent.

A scenario targets the HTTP projection by default; set scenario-level
`"transport": "mcp"` to run the same steps over the app's remote MCP endpoint
(`initialize` handshake, then one `tools/call` per step, tool names mapped
`notes.search` → `notes_search`). Write one of each for any capability with
`expose.mcp` — passing over HTTP does not prove an MCP host can reach it.
Expectations are portable: `expect.status` is the capability dispatch status on
both transports, so the same `{ "ok": false, "status": 400, "errorCode":
"invalid_input" }` holds either way.

Three MCP limits fail loudly rather than silently: a step for a capability
without `expose.mcp` (always including destructive ones), a step header other
than `authorization` (the projection forwards nothing else), and a `confirm`
round trip — destructive capabilities cannot be served over MCP today, so no
MCP tool can answer `confirmation_required`. Keep confirmation scenarios on the
HTTP transport.

`createCapabilityTestHost()` from `@pracht/core` covers the same pipeline in
unit tests without a server.

For an audit of what the whole agent surface currently exposes, run
`/audit-agent-surface`.

## Rules

1. Never expose a `destructive` capability over `webmcp`; expose it over `mcp`
   only with `agents.mcp.destructive` and a durable approval store, and say so
   to the user. Never reclassify a destructive operation as `write` to escape
   the confirmation gate.
2. Never widen a schema (drop `required`, open `additionalProperties`, raise a
   `maximum`) without saying so — `pracht plan` reports it as a widening of the
   agent-reachable surface for a reason.
3. Keep `expose`, `effect`, and `input` as inline literals.
4. Put authentication, authorization, and rate limiting in named middleware —
   the framework ships no rate limiting, no write-idempotency helper, and no
   result-size budget. Bound outputs with a `limit` input and a schema
   `maximum`.
5. Design `write` inputs to be safely repeatable; agents retry, and only
   `destructive` calls are token-gated.
6. Never register an app-wide approval endpoint or UI without your own
   authorization — who may approve is an application decision.
7. Re-run `pracht typegen` after changing a schema, name, or exposure, and
   `pracht verify` before committing.

$ARGUMENTS
