# @pracht/capabilities

Typed, protocol-neutral application capabilities for [Pracht](https://github.com/JoviDeCroock/pracht).

Define an application operation once — JSON Schema input/output, an effect
class (`read` / `write` / `destructive`), named middleware, and a server-only
`run()` — and project it to direct server invocation, a generated HTTP
endpoint, a remote MCP tool, and a WebMCP page tool for in-browser agents.

```ts
import { defineCapability } from "@pracht/capabilities";

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
    properties: { notes: { type: "array" } },
    required: ["notes"],
  },
  effect: "read",
  expose: { http: true, webmcp: true },
  async run({ input, context, request, signal }) {
    return { notes: await searchNotes(input.query, input.limit) };
  },
});
```

Register capabilities in the app manifest:

```ts
export const app = defineApp({
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
  },
  // ...
});
```

Applications outside the Pracht framework can register capability objects
with `createCapabilityHost()` from `@pracht/capabilities/server`. The
Web-standard host serves the same HTTP and remote MCP pipeline and returns
`null` for unrelated routes. `@pracht/capabilities/webmcp` exposes the page
tool registrar separately.

Capabilities are private by default; `expose.http` serves them at
`POST /api/capabilities/<name-with-dots-as-slashes>` with a typed
`{ ok, data | error }` envelope, and `expose.webmcp` registers them as WebMCP
page tools that dispatch through the HTTP projection so all enforcement stays
server-side. Validation uses a dependency-free JSON Schema subset — no ajv or
zod in your bundles.

See the [Capabilities](https://pracht.resynapse.dev/docs/capabilities) and
[Standalone Capabilities](https://pracht.resynapse.dev/docs/standalone-capabilities)
guides for the supported schema subset, integrations, and security defaults.
