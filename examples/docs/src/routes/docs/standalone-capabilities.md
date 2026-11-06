---
title: Standalone capabilities
lead: Run pracht's validated capability pipeline in an existing Web-standard server, without the pracht router, Vite plugin, or Preact.
---

## Install

```bash
npm install @pracht/capabilities
```

`@pracht/capabilities` hosts capabilities in an app that does not use the pracht framework: the same validation, middleware, prepare/commit flow, audit events, HTTP envelope, remote MCP, and WebMCP. It speaks Web-standard `Request` and `Response`, so Hono, Next.js route handlers, and Workers pass requests directly; other Node frameworks need their usual Web Request adapter.

## Define a capability

Wrap an existing service function in a capability contract:

```ts [capabilities/notes-search.ts]
import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";

interface SearchInput {
  query: string;
}

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  input: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "object" } } },
    required: ["notes"],
  },
  effect: "read",
  expose: { http: true, mcp: true },
  async run({ input }: CapabilityRunArgs<SearchInput>) {
    return { notes: await searchNotes(input.query) };
  },
});
```

Annotating `run()` with `CapabilityRunArgs<Input>` types the input and keeps the output inferred.

To reuse an existing validator, pass a Standard Schema that also implements Standard JSON Schema, such as a Zod 4 schema, as `input` or `output`. The host runs your validator, transforms included, and projects its JSON Schema to MCP and WebMCP.

## Mount the host

Create a host with `createCapabilityHost()`:

```ts [server/capability-host.ts]
import { createCapabilityHost } from "@pracht/capabilities/server";
import notesSearch from "../capabilities/notes-search.ts";

export const capabilityHost = createCapabilityHost({
  capabilities: { "notes.search": notesSearch },
  agents: {
    mcp: { serverInfo: { name: "notes", version: "1.0.0" } },
  },
});
```

`capabilityHost.fetch(request)` answers capability HTTP paths, the MCP endpoint, and OAuth protected-resource metadata, and resolves to `null` for every other URL. Put it in front of your router:

```ts [server.ts]
import { Hono } from "hono";
import { capabilityHost } from "./server/capability-host.ts";

const app = new Hono();

app.use("*", async (context, next) => {
  const response = await capabilityHost.fetch(context.req.raw);
  if (response) return response;
  return next();
});
```

Unknown URLs under `/api/capabilities/` get a `404 unknown_capability` envelope instead of falling through.

Override these defaults only when your server owns the policy:

| Option | Default | Effect |
| --- | --- | --- |
| `requireSameOrigin` | `true` | Non-GET browser calls must be same-origin. |
| `exposeErrors` | `false` | Internal error details are redacted. |
| `securityHeaders` | `true` | Default security headers are added. |
| `loaderTimeoutMs` | `30000` | Request budget; the `signal` passed to middleware and `run()` aborts when it runs out. |

## Context, middleware, and trust

Register middleware by name, and create context only for requests the host owns:

```ts
export const capabilityHost = createCapabilityHost({
  capabilities: { "notes.search": notesSearch },
  middleware: {
    auth: async ({ request }, next) => {
      if (!(await sessionFrom(request))) return new Response(null, { status: 401 });
      return next();
    },
  },
  apiMiddleware: ["auth"],
  createContext: async (request) => ({ session: await sessionFrom(request) }),
  agents: {
    webBotAuth: {
      policy: "observe",
      directories: ["https://signature-agent.example"],
    },
    mcp: {
      serverInfo: { name: "notes", version: "1.0.0" },
      auth: {
        resource: "https://app.example/mcp",
        authorizationServers: ["https://auth.example"],
        verify: async (token) => verifyWithYourIdp(token),
      },
    },
  },
});
```

The `agents` config matches [Agent trust](/docs/agent-trust), with these differences:

- Middleware and the MCP token `verify` are functions, not module paths.
- Capability names are the keys of `capabilities`; there is no manifest or file discovery.
- The confirmation secret comes from `PRACHT_CONFIRMATION_SECRET` or `setCapabilityConfirmationSecret()`.
- Destructive remote MCP tools need `agents.mcp.destructive` and a durable approval store.

To call a capability from server code, use `capabilityHost.invoke("notes.search", input)`. It runs validation and the capability's own middleware, skips `apiMiddleware`, and works for unexposed capabilities.

## Register WebMCP tools

Register page tools in the browser with `registerWebmcpTools()` from `@pracht/capabilities/webmcp`, and dispatch each call to the host's HTTP endpoint so validation and authorization stay on the server:

```ts [webmcp.ts]
import { registerWebmcpTools } from "@pracht/capabilities/webmcp";

const registrations = new AbortController();

registerWebmcpTools(
  [
    {
      name: "notes.search",
      title: "Search notes",
      description: "Find notes whose title or body matches the query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      effect: "read",
    },
  ],
  async (name, input, { signal }) => {
    const response = await fetch(`/api/capabilities/${name.replaceAll(".", "/")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
      credentials: "same-origin",
      signal,
    });
    return response.json();
  },
  { signal: registrations.signal },
);

// Remove these tools when the page or application scope that owns them ends.
registrations.abort();
```

`registerWebmcpTools()` returns `false` and registers nothing when the browser has no `document.modelContext`.

| Descriptor field | Effect |
| --- | --- |
| `effect` | `"read"` sets `readOnlyHint`. `"destructive"` tools are skipped with a console warning: `destructive operations cannot be exposed as page tools`. |
| `untrustedContent` | Sets `untrustedContentHint`. |
| `annotations` | Explicit hints, such as `consequentialHint`, merged over the derived ones. |

The third argument also accepts `exposedTo`, secure cross-origin documents allowed to use the tools; omit it to keep them same-origin. Chrome recommends at most 30 characters per tool or parameter name, 500 per tool description, 150 per parameter description, and 1.5K per result.

## Move to a pracht app

Move capability modules unchanged into `src/capabilities/`, register them in `defineApp({ capabilities })` (or let the pages router discover them), and delete the manual host. You gain typed clients, `<Form capability>`, build-time verification, route revalidation, generated WebMCP registration, `llms.txt`, and the dev Agents panel. See [Capabilities](/docs/capabilities).
