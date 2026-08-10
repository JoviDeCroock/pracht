---
title: Capabilities
lead: Define a typed operation once and pracht projects it everywhere — direct server calls, a generated HTTP endpoint, and a WebMCP page tool for in-browser agents. Explicit, validated, and private by default.
breadcrumb: Capabilities
prev:
  href: /docs/agent-skills
  title: Agent Skills
next:
  href: /docs/agent-trust
  title: Agent Trust
---

## One Contract, Many Surfaces

A capability is a typed, protocol-neutral application operation: JSON Schema input and output, an effect class (`read`, `write`, or `destructive`), optional named middleware, and a server-only `run()` function. From that single contract pracht generates:

- **Direct server invocation** — `invokeCapability()` from loaders, API routes, and middleware.
- **An HTTP endpoint** — `POST /api/capabilities/<name>` when `expose.http` is set.
- **A WebMCP page tool** — registered for in-browser agents when `expose.webmcp` is set.
- **A remote MCP tool** — served at your app's own endpoint when `expose.mcp` is set, for agents that never open a browser. See [Remote MCP](/docs/remote-mcp).

Every projection runs the same pipeline, so business rules never diverge between transports:

```text
input validation → middleware chain → run() → output validation
```

---

## Register in the Manifest

Capabilities are registered in `defineApp()`, exactly like shells and middleware. Registration is deliberately opt-in — no API route or loader is ever inferred as a capability.

```ts [src/routes.ts]
export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
    "notes.create": () => import("./capabilities/notes-create.ts"),
  },
  // shells, middleware, routes...
});
```

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

Schemas are validated by a dependency-free JSON Schema subset validator — no ajv or zod in your bundles. Unsupported keywords (`oneOf`, `$ref`, `pattern`, …) are rejected at definition time and by `pracht verify`, so an exposed capability can never silently accept more than its schema says.

Annotate `run()` with `CapabilityRunArgs<Input>` to type its input while letting TypeScript infer the concrete output. That preserves both types when the capability is passed to `createCapabilityTestHost()`. Avoid supplying only `defineCapability<Input>` — TypeScript then uses the default `unknown` output instead of inferring it. Use `defineCapability<Input, Output>` when you prefer to state both explicitly.

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

From the browser — `virtual:pracht/capabilities` contains only http-exposed names, endpoints, and effect classes; capability modules never enter the client bundle:

```ts [src/islands/NoteForm.tsx]
import { callCapability, capabilities } from "virtual:pracht/capabilities";

const result = await callCapability("notes.create", { title });
// or through the generated client — dotted names become object paths:
const same = await capabilities.notes.create({ title });
```

Both take the same path (one endpoint table, one settled event, one revalidation rule); `capabilities` is a nested view of the same call, and private capabilities are absent from it entirely. Reach for the nested form when typing a name by hand — its members are real property accesses, so a typo gets `Did you mean 'search'?` where a string literal argument gets no suggestion.

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

Concurrent calls are last-one-wins, so a search box never renders a stale response, and `data` stays visible while a follow-up call is pending. It dispatches when you call it, never during render: for data a page needs on load, run the capability in a `loader` with `invokeCapability()` so the result is server-rendered instead of fetched after hydration.

The nested client also carries each capability's generated title and description as JSDoc, so hovering `capabilities.notes.search` shows the same contract prose an agent reads.

Capability modules are server-only, and the build enforces that: importing one from client code fails with a pointer to these helpers rather than silently bundling `run()` and everything it imports for every visitor.

HTTP-exposed capabilities must declare `effect` as an inline `"read"`, `"write"`, or `"destructive"` string because the browser projection is generated by static analysis. Custom `expose.http.path` values must be exact same-origin pathnames beginning with `/`; protocol-relative URLs, queries, and fragments are rejected.

A `destructive` capability is confirmation-gated, and the call options say which half of the flow you are in — `{ prepare: true }` to obtain the token without running the operation, then the identical input with `{ confirm: token }` to commit:

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

Full options: `{ headers, signal, prepare, confirm, revalidate }`. `prepare` is not sent over the wire; the client uses it to strip any inherited confirmation header before dispatch. See [Agent Trust](/docs/agent-trust) for what the server checks on each half.

Or declaratively — the framework's `<Form>` posts straight to a capability, so the human form and the agent tool share one contract. Fields are coerced onto the input schema server-side, and without JavaScript the endpoint accepts the form-encoded post and redirects back:

```tsx [src/routes/notes.tsx]
import { Form } from "@pracht/core";

<Form capability="notes.create" onCapabilityResult={(result) => setStatus(result)}>
  <input name="title" />
  <button type="submit">Create note</button>
</Form>;
```

`capability` accepts only http-exposed names once typegen has run — a private one has no endpoint to post to, so naming it is a compile error rather than a 404 at submit time. Set `action` explicitly for a capability with a custom `expose.http.path`.

Mutations keep the page honest automatically: capabilities are effect-classed, so after any successful non-`read` call from the browser (`callCapability`, the `capabilities` client, or `<Form capability>`) the active route's loader data revalidates — no manual `revalidate()` bookkeeping. Opt out per call with `{ revalidate: false }`.

Over HTTP — every response uses a typed envelope, with path-scoped validation issues an agent can act on:

```sh
curl -X POST /api/capabilities/notes/search -H 'content-type: application/json' -d '{"query":"roadmap"}'
# { "ok": true, "data": { "notes": [...] } }
# { "ok": false, "error": { "code": "invalid_input", "issues": [{ "path": "/limit", "message": "must be <= 20" }] } }
```

A capability middleware that short-circuits with status 429 produces the typed
`rate_limited` error code on every projection. HTTP callers also keep the
middleware's `Retry-After` header.

And every call above is fully typed: `pracht typegen` writes each capability's input/output types, effect class, and exposure into `src/pracht-capabilities.d.ts`, so `invokeCapability()`, `callCapability()`, the `capabilities` client, and `<Form capability>` all read the contract from the capability name — no per-call generics. With that file in the program the compiler rejects:

| Mistake | Result |
| --- | --- |
| Unknown or misspelled capability name | compile error (a "did you mean" suggestion through the nested `capabilities` client) |
| Input that does not match the schema | compile error |
| Calling a private capability from the browser | compile error — it has no HTTP endpoint |
| Committing a `destructive` call without `confirm` | compile error |
| A capability name computed at runtime | compile error — assert `as HttpCapabilityName` |

A capability whose input schema requires nothing is callable with no argument at all: `capabilities.notes.stats()`. Where the name is a union rather than one literal, the input may be omitted only if every member accepts empty input, and any supplied input must be valid for every possible member — narrow the name first when their contracts differ. An explicit `prepare` or `confirm` is required if any member is `destructive`; the gate closes when `destructive` is possible, not only when it is certain.

Apps that have not run `pracht typegen` keep the untyped form and accept any name. Two things to know when adopting it:

- Once anything is registered, the untyped fallback no longer applies — that is what turns a mistake into a build failure. The explicit `invokeCapability<Output>(name, …)` type-argument form goes with it; drop the type argument and let inference do the work.
- Re-run `pracht typegen` after upgrading pracht. A declaration file generated before `effect` and `exposed` existed keeps working, but the exposure and confirmation checks cannot apply to it. `pracht typegen --check` catches a stale file in CI.

Runtime validation is unchanged either way, and it is the runtime — not the compiler — that answers an unknown name with an `unknown_capability` envelope carrying a "did you mean" suggestion.

---

## WebMCP: Tools for In-Browser Agents

With `expose.webmcp: true`, the client runtime registers the capability as a [WebMCP](https://developer.chrome.com/docs/ai/webmcp) page tool via `document.modelContext.registerTool()` (Chrome origin trial, with the deprecated `navigator.modelContext` fallback). The tool's `execute()` dispatches through the HTTP projection, so the agent acts as the signed-in user in their tab while validation, middleware, and policy all stay server-side.

The shim ships as its own chunk behind feature detection: browsers without the API never download it, apps without webmcp-exposed capabilities never reference it, and it works in both full-hydration and islands modes.

---

## Private by Default

- A capability without `expose` is never reachable over the network.
- Exposure requires a complete contract — `pracht verify` fails for exposed capabilities missing a description, schema, or effect class.
- `destructive` capabilities are gated by a server-verified confirmation flow and cannot be exposed to agent projections — see [Agent Trust](/docs/agent-trust).
- Output is validated too: a handler returning data outside its output schema produces a redacted 500, never the raw value.
- HTTP-exposed capabilities are listed in the generated [`/llms.txt`](/docs/llms) with their endpoint, effect class, and description, so agents can discover them without scraping.

---

## Cost When Unused

Apps that register no capabilities and configure no `agents` do not ship the agent surface. During a production build, the vite plugin reads the manifest and lets the bundler drop both the capability dispatch and Web Bot Auth verifier when neither can be present, including when `llmsTxt` only indexes pages and API routes. Development keeps the runtime available so adding a capability does not require restarting the dev server.

The analysis fails conservatively: unreadable or non-literal manifests, parse failures, spreads, shorthand registrations, and computed keys keep the runtime. Static analysis may preserve a few unused bytes, but it never silently disables a capability or agent configuration that works at runtime.

The client stays opt-in too. Capability metadata only reaches the browser through `virtual:pracht/capabilities`, and the WebMCP shim is emitted only for capabilities that set `expose.webmcp`.

---

## Inspect the Graph

The capability graph feeds every inspection surface: the `pracht dev` startup banner, `pracht inspect capabilities [--json]`, the `/_pracht` devtools page, the `inspect_capabilities` tool on the `pracht mcp` server, and the static checks in `pracht verify`.

```sh
pracht inspect capabilities
# notes.search   read   http,webmcp,mcp   /api/capabilities/notes/search
# notes.create   write  http,mcp          /api/capabilities/notes/create
```

Coming next: MCP Apps UI views rendered with Preact, so a capability can return an interactive result into an agent's chat.

For the story behind the design, read [The Agentic Web](/docs/agents); for unit, E2E, and WebMCP testing patterns, see the [Testing recipe](/docs/recipes/testing).
