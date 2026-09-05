---
title: Standalone Capabilities
lead: Mount Pracht's validated capability pipeline in an existing Web-standard server without adopting the Pracht router, Vite plugin, or Preact.
breadcrumb: Standalone Capabilities
prev:
  href: /docs/capabilities
  title: Capabilities
next:
  href: /docs/agent-trust
  title: Agent Trust
---

## Adopt One Contract at a Time

`@pracht/capabilities` can host operations in an application that does not use the Pracht framework. You still get the same JSON Schema validation, named middleware, effect policy, destructive prepare/commit flow, audit events, HTTP envelope, remote MCP projection, and WebMCP registrar.

The standalone surface uses Web-standard `Request` and `Response`. Hono, Next.js route handlers, and Workers can pass requests directly. Node frameworks with their own request types need their normal Web Request/Response adapter.

```bash
npm install @pracht/capabilities
```

## Define the Capability

Wrap an existing service function with the same contract a Pracht app uses:

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

Annotating `run()` with `CapabilityRunArgs<Input>` types the input while preserving inference for the concrete output. The standalone host uses the same capability object and typing rule as a Pracht app.

If the application already validates this operation with a Standard Schema
that also implements Standard JSON Schema, pass that validator directly as
`input` or `output`. Zod 4 schemas work without conversion glue. The host runs
the original validator — including async checks, defaults, and transforms —
while projecting the derived JSON Schema to MCP and WebMCP. The embedding app
keeps its schema library server-side; only the JSON descriptor belongs in a
browser registration.

## Mount the Host

`createCapabilityHost()` registers capability objects at runtime. Its `fetch()` method returns a response for a capability HTTP path, the configured MCP path, or OAuth protected-resource metadata. It returns `null` for unrelated URLs, without creating application context or verifying agent signatures, so it is safe to place before the rest of a wildcard router.

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

Mount it in Hono, or any server that already exposes a Web-standard request:

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

The host owns unknown URLs below `/api/capabilities/` and answers them with a typed 404 envelope. URLs outside its generated and custom capability paths fall through. An explicit application route therefore cannot accidentally trigger context creation, authentication, or capability middleware.

The default protections match the framework host: non-GET browser calls require same-origin provenance, errors are redacted, and default security headers are applied. Set `requireSameOrigin`, `exposeErrors`, or `securityHeaders` only when the embedding server deliberately owns that policy.

## Context, Middleware, and Trust

Register middleware functions by name and create context only for traffic the host owns:

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

Standalone differences are limited to registration:

- Middleware and the MCP token verifier are functions rather than module paths.
- There is no app manifest or static discovery; capability names are the keys in `capabilities`.
- The confirmation secret still comes from `PRACHT_CONFIRMATION_SECRET` or `setCapabilityConfirmationSecret()`.
- Destructive remote MCP tools still require `agents.mcp.destructive` and a durable approval store.

For server-side composition, `capabilityHost.invoke("notes.search", input)` runs private or exposed capabilities through the same validation and middleware pipeline.

## Register WebMCP Tools

`@pracht/capabilities/webmcp` is the browser-side registrar. Keep authorization and validation on the server by dispatching each page tool through the hosted HTTP endpoint:

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

Registration is a no-op when `document.modelContext` is absent. Each descriptor uses only WebMCP's `readOnlyHint` and optional `untrustedContentHint`; remote MCP derives its additional MCP annotations separately. Destructive page tools are refused because browser registration is not a server-verified confirmation boundary.

## Moving to Pracht Later

Capability modules do not change. Move them to `src/capabilities/`, register them in `defineApp({ capabilities })` or let the pages router discover them, and remove the manual host. Pracht then adds generated typed clients, `<Form capability>`, static verification, route revalidation, generated WebMCP registration, `llms.txt`, and the development Agents panel. See [Capabilities](/docs/capabilities) for the integrated workflow.
