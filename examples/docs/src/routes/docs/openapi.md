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

OpenAPI support is opt-in through `@pracht/openapi`. Add its Vite plugin after `pracht()` so it can
inspect Pracht's generated API graph:

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

The plugin serves `/openapi.json` during development. Enabling `ui: "scalar"` or `ui: "swagger"`
also serves `/docs`. Both paths accept `GET` and `HEAD`; other methods receive `405`.

During `pracht build`, the same resources become static files at
`dist/client/openapi.json` and `dist/client/docs/index.html`. Node and Cloudflare serve them through
their normal static-asset paths, while Vercel also receives an explicit route for the directory-index
UI page.

Use custom paths when these defaults overlap with app routes:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  documentPath: "/api/openapi.json",
  ui: { provider: "swagger", path: "/api/reference" },
});
```

## Document response contracts

Pracht can discover API paths, named HTTP methods, path parameters, and convertible `defineApi()`
request schemas. Arbitrary `Response` objects and erased TypeScript types do not expose enough
information to infer response statuses and payloads honestly.

Wrap a validated handler with `defineOpenApi()` to attach that documentation without changing its
runtime behavior or `apiFetch()` inference:

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

Standard JSON Schema request validators use their input projection. Request bodies are marked
optional when their validator accepts the `undefined` value that `defineApi()` receives for an empty
body. Response schemas use their output projection. Raw JSON Schema objects also work for response
bodies.

Pracht adds its known `400` body-parsing and `422` validation responses. A handler without an
explicit response descriptor receives a valid undocumented `default` response and a scoped warning,
so one incomplete route does not erase the rest of the document.

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

The generated JSON document is the stable integration point. The optional UI is a small static HTML
shell backed by that endpoint:

- `ui: "scalar"` loads the pinned Scalar browser bundle.
- `ui: "swagger"` loads pinned Swagger UI assets, enables deep links, and disables Swagger's remote
  validator.
- An options object can override `scriptUrl` for either provider and `styleUrl` for Swagger, allowing
  the assets to be self-hosted from `public/`.

The default bundles come from jsDelivr, and the shell contains a small inline initialization script.
Strict Content Security Policy deployments must allow the selected asset origin and the inline
script by hash, or use an app-owned UI page with the required nonce policy.

Treat emitted OpenAPI files as public unless the hosting layer protects them. Avoid secrets and
internal credentials in descriptions or examples, and remember that “Try it out” sends real requests
to API handlers with their normal authentication, authorization, CSRF, rate-limit, and confirmation
requirements.

## Current boundaries

- Default-export API handlers are omitted because their supported methods cannot be inferred.
- Catch-all paths become a single `{path}` parameter and warn about slash encoding.
- Request bodies currently default to `application/json`.
- Capability HTTP projections are not included yet.
- Drift enforcement uses deterministic build output and `failOnWarnings`; there is no dedicated diff
  command yet.
