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
  expose: { http: true, webmcp: true },
  async run({ input }) {
    return { notes: searchNotes(input.query, input.limit) };
  },
});
```

Schemas are validated by a dependency-free JSON Schema subset validator — no ajv or zod in your bundles. Unsupported keywords (`oneOf`, `$ref`, `pattern`, …) are rejected at definition time and by `pracht verify`, so an exposed capability can never silently accept more than its schema says.

---

## Call It from Anywhere

Server-side — including private capabilities that have no `expose` at all:

```ts [src/routes/notes.tsx]
import { invokeCapability } from "@pracht/core";

export async function loader({ request, context, signal }) {
  const result = await invokeCapability("notes.search", { query: "roadmap" }, { request, context, signal });
  return result.ok ? result.data : { notes: [] };
}
```

From the browser — `virtual:pracht/capabilities` contains only http-exposed names and endpoints; capability modules never enter the client bundle:

```ts [src/islands/NoteForm.tsx]
import { callCapability } from "virtual:pracht/capabilities";

const result = await callCapability("notes.create", { title });
```

Over HTTP — every response uses a typed envelope, with path-scoped validation issues an agent can act on:

```sh
curl -X POST /api/capabilities/notes/search -H 'content-type: application/json' -d '{"query":"roadmap"}'
# { "ok": true, "data": { "notes": [...] } }
# { "ok": false, "error": { "code": "invalid_input", "issues": [{ "path": "/limit", "message": "must be <= 20" }] } }
```

And both calls above are fully typed: `pracht typegen` generates input/output types from the capability schemas into `src/pracht-capabilities.d.ts`, so `invokeCapability()` and `callCapability()` infer both sides from the capability name — no per-call generics.

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

## Inspect the Graph

The capability graph feeds every inspection surface: the `pracht dev` startup banner, `pracht inspect capabilities [--json]`, the `/_pracht` devtools page, the `inspect_capabilities` tool on the `pracht mcp` server, and the static checks in `pracht verify`.

```sh
pracht inspect capabilities
# notes.search   read   http,webmcp   /api/capabilities/notes/search
# notes.create   write  http          /api/capabilities/notes/create
```

Coming next: a remote MCP endpoint (`/mcp`) projecting the same capabilities to out-of-browser agents, and MCP Apps UI views rendered with Preact.

For the story behind the design, read [The Agentic Web](/docs/agents); for unit, E2E, and WebMCP testing patterns, see the [Testing recipe](/docs/recipes/testing).
