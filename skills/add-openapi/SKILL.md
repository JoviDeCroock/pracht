---
name: add-openapi
version: 1.0.1
description: |
  Wire `@pracht/openapi`: generate an OpenAPI 3.1 document from `defineApi()`
  routes, attach response contracts with `defineOpenApi()`, serve an optional
  Scalar or Swagger UI, handle deploy-base and CSP, and gate completeness in CI.
  Use for "add OpenAPI", "generate an API spec", "add Swagger", "publish API
  docs", "document my API routes".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add OpenAPI

`@pracht/openapi` is an opt-in companion package (`docs/OPENAPI.md`). Ordinary
`defineApi()` routes keep their authoring, runtime behavior, and `apiFetch()`
type inference — the package only reads the resolved server graph and owns its
own descriptor.

## Step 1: Inventory the API first

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_api`/`inspect_routes`/`doctor`/`verify` tools over shelling out.

```bash
pracht inspect api --json   # endpoint paths, methods, hasDefaultHandler
```

Note two things before generating anything:

- **Default-export handlers** are not expanded — their supported methods cannot
  be inferred honestly. Split them into named method exports if they belong in
  the document.
- **Catch-all paths** become a single `{path}` parameter and emit a warning
  about slash encoding.

Ask the user whether the document should be public, and whether they want a
reference UI at all (`ui: false` is the default).

## Step 2: Install and register the plugin

```bash
pnpm add @pracht/openapi
```

```ts
// vite.config.ts — the companion plugin goes after pracht()
import { prachtOpenApi } from "@pracht/openapi/vite";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    pracht(),
    prachtOpenApi({
      info: {
        title: "Acme API",
        version: "1.0.0",
        description: "Public HTTP API for Acme.",
      },
      ui: "scalar", // or "swagger", an object, or omit for no UI
    }),
  ],
});
```

This reserves `/openapi.json` and (with a UI) `/docs`. Both are live in the
Vite dev server; `pracht build` writes `dist/client/openapi.json` and
`dist/client/docs/index.html`, which Node, Cloudflare, Netlify, and Vercel serve
through their existing static-asset paths. Paths are configurable via
`documentPath` and `ui.path`; the document path **must** end in `.json` so
static hosts assign the right media type.

Reserved paths shadow app routes: development logs a warning on a collision and
production generation replaces the colliding public/build file and reports the
replacement. Grep the manifest and `public/` for `/docs` before enabling the UI
on an app that already documents itself there.

## Step 3: Attach the metadata that cannot be inferred

Paths, methods, path params, and convertible request validators come from the
routes. Status codes and payload shapes cannot be recovered from an arbitrary
`Response` or an erased TypeScript type — declare them:

```ts
import { defineApi, json } from "@pracht/core";
import { defineOpenApi } from "@pracht/openapi";

export const POST = defineOpenApi(
  defineApi({
    body: createItemSchema,
    handler: ({ body }) => json({ id: createItem(body) }, { status: 201 }),
  }),
  {
    operationId: "createItem",
    summary: "Create an item",
    tags: ["items"],
    responses: {
      201: { description: "Item created", body: itemSchema },
    },
  },
);
```

`defineOpenApi()` mutates and returns the same handler — validation, dispatch,
and client inference stay with pracht. Generation adds the framework-known 400
and 422 validation responses itself, marks a request body optional when the
validator accepts the empty-body `undefined`, and emits a valid undocumented
`default` response plus a scoped warning when the contract is unknown.

## Step 4: Shared document metadata

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  document: {
    servers: [
      { url: "https://api.example.com", description: "Production" },
      { url: "http://localhost:3000", description: "Local development" },
    ],
    tags: [{ name: "items", description: "Item lifecycle" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});
```

A security scheme referenced by an operation's `security` must exist in
`document.components.securitySchemes`. `document.security` applies globally; set
`security: []` on an operation to mark it public.

**Deploy base:** with Vite `base: "/app/"`, the UI loads its document from
`/app/openapi.json`, and generation adds `servers: [{ url: "/app" }]` when
`document.servers` is omitted so "Try it out" reaches base-prefixed routes. An
explicit `document.servers` always wins, including an empty array.

## Step 5: Make it a CI gate

Conversion failures are warnings by default, so one unsupported handler does not
erase the document. Once every public operation has an explicit response
contract, tighten it:

```ts
prachtOpenApi({ info: { title: "Acme API", version: "1.0.0" }, failOnWarnings: true });
```

Any warning then fails the dev request and `pracht build`. There is no dedicated
diff/check command yet — deterministic build output plus `failOnWarnings` is how
drift is caught.

## Step 6: UI provider, CDN, and CSP

- `ui: "scalar"` — modern reference with request examples and an API client.
- `ui: "swagger"` — Swagger UI, with deep links on and the remote validator
  disabled so internal documents are never sent to `validator.swagger.io`.
- Both shells load pinned browser assets from jsDelivr. Apps with offline
  requirements or a no-third-party-CDN policy should self-host and override
  (`scriptUrl` for both providers, `styleUrl` for Swagger), copying the pinned
  distribution into `public/vendor/`.
- The shell also contains a small inline bootstrap script. A strict CSP must
  allow that exact script by hash (and the asset origin), or the page must be
  replaced with an app-owned route following the app's nonce policy —
  self-hosting the bundle alone does not fix an inline-script ban. See
  `docs/CSP.md` and `/audit-headers`.

## Step 7: Verify

```bash
pracht dev             # GET /openapi.json and the UI path
pracht build
pracht verify --json
```

Confirm the document parses, every intended operation is present with a real
response contract, and no `500`-only `default` responses remain for public
endpoints. Then run `/audit-headers` if a CSP is in place and
`/audit-agent-surface` if the document is part of a deliberate agent-facing
surface.

## Rules

1. Treat the document and UI as public unless the hosting layer protects the
   emitted static files. No secrets, internal hostnames, or credentials in
   descriptions or examples.
2. Never embed an OAuth client secret in UI configuration — browser-delivered
   configuration is observable by every visitor.
3. Keep the UI and JSON on the same origin.
4. "Try it out" sends real requests: mutation endpoints must carry the same
   authentication, authorization, CSRF, rate-limit, and confirmation policies as
   any other client.
5. Set a sane static cache policy for the document; immutable caching is wrong
   unless the URL is versioned or deployments purge it.
6. Do not document a capability HTTP projection here — capability endpoints are
   not included in generation yet (`/add-capabilities` owns that contract).
7. Never overwrite an existing `vite.config.ts` or a hand-written
   `public/openapi.json` — diff first and confirm with `AskUserQuestion`.

$ARGUMENTS
