---
title: OpenAPI
lead: Generate an OpenAPI 3.1 document, and optionally a Scalar or Swagger UI, from your API routes.
---

## Install the companion package

Install `@pracht/openapi` and add its Vite plugin after `pracht()`:

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

`pracht dev` serves the document at `/openapi.json` and, with `ui`, a reference page at `/docs`. `pracht build` writes them as static files: `dist/client/openapi.json` and `dist/client/docs/index.html`.

| Option | Default | Purpose |
| ------ | ------- | ------- |
| `info` | required | OpenAPI `info` object; `title` and `version` must be non-empty |
| `documentPath` | `/openapi.json` | URL and output path of the document; must end in `.json` |
| `ui` | `false` | `"scalar"`, `"swagger"`, or `{ provider, path, title, scriptUrl, styleUrl }` |
| `document` | | `servers`, `tags`, `externalDocs`, `security`, and `components` |
| `failOnWarnings` | `false` | Turn generation warnings into failed dev requests and builds |
| `capabilities` | `false` | Also document capabilities with `expose.http` |

Move the files when the defaults overlap with app routes:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  documentPath: "/api/openapi.json",
  ui: { provider: "swagger", path: "/api/reference" },
});
```

## Document response contracts

pracht discovers API paths, named HTTP methods, path parameters, and `defineApi()` request schemas. It cannot infer response statuses or payloads, so wrap the handler with `defineOpenApi()` to document them. Runtime behavior and `apiFetch()` types do not change:

```ts [src/api/items.ts]
import { defineApi, json } from "@pracht/core";
import { defineOpenApi } from "@pracht/openapi";

import { createItem, createItemSchema, itemSchema } from "../server/items.ts";

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

The descriptor also accepts `description`, `deprecated`, and `security`. Each response takes a `description`, an optional `body` schema, and a `contentType` (default `application/json`).

Request schemas are documented by their input type and response schemas by their output type. A response `body` can also be a raw JSON Schema object. A request body is optional when its validator accepts `undefined`.

pracht adds the validation responses itself: `400` when a `body` schema is set, and `422` when any schema is. A handler without a descriptor gets an undocumented `default` response and an `undocumented_response` warning.

To make missing documentation fail development requests and production builds:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  failOnWarnings: true,
});
```

## Include capabilities

Set `capabilities: true` to also document every [capability](/docs/capabilities) with `expose.http`:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  capabilities: true,
});
```

Each one becomes a `POST` operation at its HTTP path:

- `operationId` is the capability name; summary and description come from its title and description.
- The request body is its input schema.
- The `200` response is the success envelope `{ ok: true, data }` with the output schema as `data`; `default` is the error envelope.
- The `x-pracht-effect` extension carries the effect class, and destructive capabilities list the optional `x-pracht-confirm` header.

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

Global `security` applies to every operation. Set `security: []` in a `defineOpenApi()` descriptor to mark one operation public, or give it another requirement.

When Vite's `base` is not `/` and you set no `servers`, the document lists the base as its server.

## Choose and deploy a reference UI

The UI is a static page that renders the JSON document:

- `ui: "scalar"` loads a pinned Scalar bundle.
- `ui: "swagger"` loads pinned Swagger UI assets, with deep links on and the remote validator off.
- An options object can set `scriptUrl` (either provider) and `styleUrl` (Swagger only) to self-host the assets from `public/`.

The default assets come from jsDelivr, and the page has a small inline script. Under a strict Content Security Policy, allow that origin and the script's hash, or serve your own UI page with a nonce.

Treat emitted OpenAPI files as public unless the host protects them, and keep secrets out of descriptions and examples. "Try it out" sends real requests, subject to your API's authentication, CSRF protection, and rate limits.

## Generating the document yourself

To serve the document from your own API route, for example behind auth middleware, or to write it into a repository, call the functions directly:

```ts
import { createOpenApiUiHtml, generateOpenApiDocument } from "@pracht/openapi";
```

`generateOpenApiDocument({ info, document, routes, loadModule, capabilities })` resolves to `{ document, warnings }`. `routes` lists API routes as `{ file, path }`, and `loadModule(file)` imports the module for one of them.

`createOpenApiUiHtml({ provider, documentUrl, title, scriptUrl, styleUrl })` returns the Scalar or Swagger page for a document URL.

## Limitations

- Default-export API handlers are left out, because their methods cannot be inferred (`default_handler_omitted` warning).
- Catch-all paths become a single `{path}` parameter and warn about slash encoding.
- Request bodies are documented as `application/json`.
- There is no drift-diff command; use `failOnWarnings` and the deterministic build output.
