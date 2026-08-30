---
title: Standalone Capabilities
lead: Mount the capability suite — HTTP endpoints, remote MCP, WebMCP page tools — inside an app you already have. No manifest, no build plugin, no framework migration; adopt one contract at a time.
breadcrumb: Standalone
prev:
  href: /docs/remote-mcp
  title: Remote MCP
next:
  href: /docs/recipes/i18n
  title: i18n
---

## Adopt the Contract, Not the Framework

Everything on the previous pages — `defineCapability()`, the validated dispatch pipeline, the destructive prepare/commit flow, Web Bot Auth, the remote MCP endpoint — lives in `@pracht/capabilities`, a zero-dependency package built on Web-standard `Request`/`Response`. None of it needs the pracht router, Vite plugin, or Preact.

That makes incremental adoption a ladder rather than a rewrite:

1. Wrap operations you already have in `defineCapability()` — a typed contract around existing service functions.
2. Mount `createCapabilityHost()` in your existing server — Express, Hono, Next.js, a Cloudflare Worker — and you have validated HTTP endpoints and a remote MCP server.
3. Register the same operations as WebMCP page tools with `registerWebmcpTools()`.
4. If you later adopt pracht, your capability modules move over unchanged — registration in `defineApp({ capabilities })` is the only difference.

```bash
npm install @pracht/capabilities
```

## Define a Capability

Exactly the contract described in [Capabilities](/docs/capabilities) — one JSON Schema input/output pair, an effect class, and a server-only `run()`:

```ts [capabilities/notes-search.ts]
import { defineCapability } from "@pracht/capabilities";
import { searchNotes } from "../services/notes.ts";

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
  async run({ input }) {
    return { notes: await searchNotes(input.query) };
  },
});
```

## Mount the Host

`createCapabilityHost()` builds a `(Request) => Promise<Response | null>` from capability objects registered at runtime. It answers capability HTTP paths, the MCP endpoint, and the OAuth well-known document; it resolves `null` for every other URL so your existing routing keeps working.

```ts [server/capability-host.ts]
import { createCapabilityHost } from "@pracht/capabilities/server";
import notesSearch from "../capabilities/notes-search.ts";

export const host = createCapabilityHost({
  capabilities: {
    "notes.search": notesSearch,
  },
  agents: {
    mcp: { serverInfo: { name: "notes", version: "1.0.0" } },
  },
});
```

Hono (or any server that hands you a Web-standard `Request`):

```ts [server.ts]
import { Hono } from "hono";
import { host } from "./server/capability-host.ts";

const app = new Hono();
app.use("*", async (c, next) => {
  const response = await host.fetch(c.req.raw);
  if (response) return response;
  await next();
});
// ...the rest of your app's routes
```

A Next.js App Router catch-all:

```ts [app/[...capability]/route.ts]
import { host } from "@/server/capability-host";

const handler = async (request: Request) =>
  (await host.fetch(request)) ?? new Response("Not found", { status: 404 });

export { handler as GET, handler as POST };
```

A Cloudflare Worker or Hono app passes its `Request` straight through the same way. The host serves:

- `POST /api/capabilities/notes/search` — the generated HTTP endpoint with the typed `{ ok, data } | { ok: false, error }` envelope, form-post coercion, and per-capability middleware.
- `POST /mcp` — stateless Streamable HTTP MCP: `initialize`, `tools/list`, `tools/call`, with the transport hardening described in [Remote MCP](/docs/remote-mcp) (browser provenance and ambient cookies rejected).
- `/.well-known/oauth-protected-resource` — when `agents.mcp.auth` is configured.

This is not a re-implementation: the host calls the same `handleCapabilityRequest()` / `handleMcpRequest()` pipeline a pracht app serves, so validation, middleware short-circuits, agent policy, audit events, and the destructive confirmation flow behave identically down to the error codes.

## The Trust Layer Comes Along

Everything in [Agent Trust](/docs/agent-trust) works standalone, with function registration instead of module references:

```ts
import {
  createCapabilityHost,
  createSqlApprovalStore,
  setCapabilityApprovalStore,
} from "@pracht/capabilities/server";

setCapabilityApprovalStore(createSqlApprovalStore({ execute: runQuery }));

export const host = createCapabilityHost({
  capabilities: { "notes.delete": notesDelete }, // effect: "destructive"
  middleware: {
    auth: async (args, next) => {
      if (!(await sessionFrom(args.request))) return new Response(null, { status: 401 });
      return next();
    },
  },
  apiMiddleware: ["auth"],
  agents: {
    webBotAuth: { policy: "observe", directories: ["https://signature-agent.example"] },
    mcp: {
      destructive: true,
      auth: {
        resource: "https://app.example/mcp",
        authorizationServers: ["https://auth.example"],
        verify: async (token) => verifyWithYourIdp(token), // the verifier function, directly
      },
    },
  },
  createContext: async (request) => ({ session: await sessionFrom(request) }),
});
```

Notes that differ from a pracht app:

- **Middleware are functions**, registered by name; capabilities reference them via `middleware: ["auth"]` exactly as before. `apiMiddleware` wraps every HTTP/MCP dispatch, like `defineApp({ api: { middleware } })`.
- **`agents.mcp.auth.verify` is the verifier function itself** — there is no client bundle to keep it out of.
- **The confirmation secret** still comes from `PRACHT_CONFIRMATION_SECRET` or `setCapabilityConfirmationSecret()`; destructive capabilities fail closed without it.
- **`exposeErrors` defaults to `false`** (production redaction) and `requireSameOrigin` defaults to `true` — the same CSRF stance pracht applies. The host also sets pracht's four default security headers; pass `securityHeaders: false` if your server owns them.
- **Paths are served as configured** — the generated `/api/capabilities/*` prefix, any custom `expose.http.path`, and `agents.mcp.path` all match against the request URL as-is, so mount the host where those paths are reachable at the origin.

Direct server-side composition works too: `host.invoke("notes.search", input)` runs the same pipeline (private capabilities included) and resolves to the typed envelope.

## WebMCP on Any Site

The registrar behind pracht's generated page tools is published as `@pracht/capabilities/webmcp`. Give it tool metadata and a dispatch that reaches your capability endpoint, and any page can offer tools to in-browser agents:

```ts [webmcp.ts]
import { registerWebmcpTools } from "@pracht/capabilities/webmcp";

registerWebmcpTools(
  [
    {
      name: "notes.search",
      title: "Search notes",
      description: "Find notes whose title or body matches the query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      effect: "read",
    },
  ],
  async (name, input, { signal }) => {
    const response = await fetch(`/api/capabilities/${name.replace(/\./g, "/")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
      credentials: "same-origin",
      signal,
    });
    return response.json();
  },
);
```

Annotations (`readOnlyHint`, `idempotentHint`, …) derive from the `effect` class with the same policy as the remote MCP projection, registration no-ops when the browser lacks the API, and destructive tools are refused — the page is not a security boundary. Keep validation and policy server-side by routing dispatch through the host.

## Check It Like an Agent Would

`pracht eval` speaks plain HTTP and MCP JSON-RPC against any base URL — it does not require a pracht app:

```bash
npx @pracht/cli eval --url https://app.example    # runs evals/**/*.eval.json
```

Point its scenarios at your standalone endpoints to verify the contract an agent actually experiences, including the prepare/commit flow for destructive operations.

## When You Outgrow Standalone

The framework adds the parts that need a build and a router: `<Form capability>` with no-JS fallback and automatic route revalidation, typed clients from `pracht typegen` (compile-error wrong calls), `pracht verify`/`inspect` over the app graph, generated `llms.txt`, the dev-server Agents panel, and WebMCP registration generated from the same static analysis as everything else. Your capability modules carry over unchanged — move them into `src/capabilities/` and register the names in `defineApp({ capabilities })`. See [Capabilities](/docs/capabilities).
