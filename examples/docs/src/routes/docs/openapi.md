---
title: OpenAPI
lead: Generate an OpenAPI 3.1 document and optional Scalar or Swagger UI from Pracht API routes without changing ordinary route authoring.
breadcrumb: OpenAPI
prev:
  href: /docs/api-validation
  title: API Validation
next:
  href: /docs/middleware
  title: Middleware
---

## Install the companion package

OpenAPI support is opt-in through `@pracht/openapi`. Add its Vite plugin after `pracht()`:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { prachtOpenApi } from "@pracht/openapi/vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [
    pracht(),
    prachtOpenApi({
      info: {
        title: "Acme API",
        version: "1.0.0",
        description: "Public HTTP API for Acme.",
      },
      ui: "scalar",
    }),
  ],
});
```

In development the plugin serves `/openapi.json`, and `ui: "scalar"` or `ui: "swagger"` adds a
reference page at `/docs`. `pracht build` writes them as static files, `dist/client/openapi.json` and
`dist/client/docs/index.html`.

Use custom paths when these defaults overlap with app routes:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  documentPath: "/api/openapi.json",
  ui: { provider: "swagger", path: "/api/reference" },
});
```

## Document response contracts

Pracht discovers API paths, named HTTP methods, path parameters, and `defineApi()` request schemas.
It cannot infer response statuses or payloads, so wrap the handler with `defineOpenApi()` to document
them. Runtime behavior and `apiFetch()` types are unchanged:

```ts [src/api/items.ts]
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

Request schemas are documented by their input type and response schemas by their output type.
Response bodies also accept raw JSON Schema objects. A request body is optional when its validator
accepts `undefined`.

Pracht adds the `400` and `422` validation responses itself. A handler without a response descriptor
gets an undocumented `default` response and a warning.

Set `failOnWarnings: true` when documentation completeness should fail development requests and
production builds:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  failOnWarnings: true,
});
```

## Add servers and authentication

Use `document` for metadata shared across operations:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  document: {
    servers: [{ url: "https://api.example.com", description: "Production" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});
```

Global security applies to every operation. Set `security: []` in a `defineOpenApi()` descriptor to
mark one operation public, or provide another named security requirement.

## Choose and deploy a reference UI

The UI is an optional static page that renders the JSON document:

- `ui: "scalar"` loads a pinned Scalar bundle.
- `ui: "swagger"` loads pinned Swagger UI assets, with deep links on and the remote validator off.
- An options object can set `scriptUrl` for either provider and `styleUrl` for Swagger, to self-host
  the assets from `public/`.

The default assets come from jsDelivr, and the page has a small inline script. Under a strict Content
Security Policy, allow that origin and the script's hash, or serve your own UI page with a nonce.

Treat emitted OpenAPI files as public unless the host protects them, and keep secrets out of
descriptions and examples. “Try it out” sends real requests, subject to your API's normal
authentication, CSRF, and rate limits.

## Generating the document yourself

To serve the spec from your own API route, for example behind auth middleware,
or to write it into a repository at build time, call the functions directly:

```ts
import { generateOpenApiDocument, createOpenApiUiHtml } from "@pracht/openapi";
```

`generateOpenApiDocument()` builds the OpenAPI 3.1 document from the resolved
app graph and resolves to `{ document, warnings }`, the warnings
`failOnWarnings` acts on. `createOpenApiUiHtml({ provider, documentUrl, title?,
scriptUrl?, styleUrl? })` returns the Scalar or Swagger page for it.

## Current boundaries

- Default-export API handlers are omitted because their supported methods cannot be inferred.
- Catch-all paths become a single `{path}` parameter and warn about slash encoding.
- Request bodies currently default to `application/json`.
- Capability HTTP projections are not included yet.
- There is no dedicated drift-diff command; use `failOnWarnings` and the deterministic build output.
