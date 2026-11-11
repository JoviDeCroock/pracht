---
title: Capabilities
lead: Define a typed operation once and call it from server code, over HTTP, as a WebMCP page tool, or as a remote MCP tool.
---

A capability is a typed application operation: JSON Schema input and output, an effect class (`read`, `write`, or `destructive`), optional named middleware, and a server-only `run()` function. From one definition pracht serves:

| Surface | Turn it on | Callers |
| --- | --- | --- |
| Direct server call | Always available | `invokeCapability()` in loaders, API routes, and middleware |
| HTTP endpoint | `expose.http` | `POST /api/capabilities/<name>`, the generated browser client, `<Form capability>` |
| WebMCP page tool | `expose.webmcp` (needs `expose.http`) and the route's `capabilities` list | An agent in the user's browser tab. See [WebMCP](/docs/mcp-tools#webmcp-tools-for-in-browser-agents) |
| Remote MCP tool | `expose.mcp` and `defineApp({ agents: { mcp } })` | An agent without a browser. See [Remote MCP](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser) |

Every surface runs the same pipeline:

```text
input validation → middleware chain → run() → output validation → audit event
```

## Register capabilities

Install the package, then add each capability to `defineApp({ capabilities })`, like shells and middleware. Then list the page tools each route offers:

```sh
pnpm add @pracht/capabilities
```

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

Both routers support capabilities. With the [pages router](/docs/pages-router#capabilities-via-srccapabilities), every module in `src/capabilities/` is registered automatically, and `agents` is configured in `src/pages/_app.config.ts`. Name a capability with `defineCapability({ name })` or let the filename provide it (`notes-search.ts` becomes `notes.search`). A page lists its tools in an inline `CAPABILITIES` export (not in `_app.tsx` or `404.tsx`):

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

Point `<Form>` at a capability so the human form and the agent tool share one contract. Fields are coerced onto the input schema. Successful native submissions redirect back; configure [form feedback](/docs/recipes/forms#capability-form-feedback) to show a retry form after invalid input.

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

## Private by default

- A capability without `expose` is never reachable over the network.
- `pracht verify` fails for an exposed capability missing a description, schema, or effect class.
- `destructive` capabilities need server-verified confirmation over HTTP and [remote MCP](/docs/mcp-tools#destructive-tools), and are never WebMCP page tools.
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
| `addCapabilityAuditListener()` (production) | Every dispatch; see [Audit trail](/docs/agent-audit) |
| [`pracht dev-mcp`](/docs/coding-agents#the-authoring-mcp-server) | `inspect_capabilities` and `inspect_agents` for coding agents |
| [Dev page tools](/docs/coding-agents#debugging-in-the-tab-dev-page-tools) | Read-only `pracht_*` WebMCP tools on every dev page |

To serve capabilities to agents, read [WebMCP and remote MCP](/docs/mcp-tools). For identity and confirmation rules, read [Agent trust](/docs/agent-trust); for recording every call, [Audit trail](/docs/agent-audit). For unit, E2E, and WebMCP test patterns, see the [Testing recipe](/docs/recipes/testing).
