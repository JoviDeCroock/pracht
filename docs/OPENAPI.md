# OpenAPI

`@pracht/openapi` is an opt-in companion package for generating and serving an
OpenAPI 3.1 document from Pracht API routes. Ordinary `defineApi()` routes keep
their existing authoring, runtime behavior, and client inference.

## Install and enable

Add the companion plugin after `pracht()` so it can inspect the generated
server graph:

```ts
// vite.config.ts
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

This reserves two paths while enabled:

- `/openapi.json` — the OpenAPI 3.1 document;
- `/docs` — the optional reference UI (`ui: false` is the default).

Both paths are live in the normal Vite development server. `pracht build`
writes the equivalent static files to `dist/client/openapi.json` and, when the
UI is enabled, `dist/client/docs/index.html`. Node, Cloudflare, Netlify, and Vercel then
serve them through their existing static-asset paths.

Paths are configurable:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  documentPath: "/api/openapi.json",
  ui: {
    provider: "swagger",
    path: "/api/reference",
    title: "Acme API reference",
  },
});
```

The endpoints accept `GET` and `HEAD`. Other methods receive `405` in
development. Development responses use `Cache-Control: no-store`; production
cache policy belongs to the deployment's static-asset configuration. The
document path must end in `.json` so every adapter's static host assigns the
correct media type.

### Deploy base

With Vite `base: "/app/"`, the output tree stays unchanged while the reference
UI loads its document from `/app/openapi.json`. When `document.servers` is
omitted, generation also adds `servers: [{ url: "/app" }]`, so Scalar and
Swagger “Try it out” requests reach the app's base-prefixed API routes. An
explicit `document.servers` value always wins, including an empty array.

Generated paths are reserved while the plugin is enabled. Development logs a
warning when a Pracht route or `public/` file collides; production generation
replaces a colliding public/build file and reports that replacement.

## Document responses and operations

Pracht can recover paths, methods, path parameters, and convertible request
validators from existing routes. Response status codes and payloads cannot be
inferred from arbitrary `Response` objects or erased TypeScript types. Attach
that OpenAPI-only metadata with `defineOpenApi()`:

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

The wrapper mutates and returns the same handler. Pracht remains responsible
for validation, dispatch, and `apiFetch()` type inference; the companion
package owns only its descriptor.

For each named method, generation:

1. Converts Pracht `:param` paths to OpenAPI `{param}` paths.
2. Reads path, query, and body validators from `defineApi()`.
3. Uses Standard JSON Schema's input projection for wire request schemas.
4. Marks a request body optional when its validator accepts the same
   `undefined` value that `defineApi()` passes for an empty body.
5. Adds framework-known 400 and 422 validation responses.
6. Uses explicit response descriptors and their output schemas when present.
7. Emits a valid undocumented `default` response and a scoped warning when
   the response contract is unknown.

Route module and schema conversion failures are warnings, so one unsupported
handler does not erase the rest of the document. Set `failOnWarnings: true` to
turn any warning into a failed development request and failed `pracht build`:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  failOnWarnings: true,
});
```

This is useful as a CI completeness gate once every public operation has an
explicit response contract.

### Servers, tags, and authentication

Use `document` for OpenAPI metadata shared by the whole API. Security scheme
names referenced by a `defineOpenApi({ security })` operation must exist in
`document.components.securitySchemes`:

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
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});
```

`document.security` applies globally. Set `security: []` on a documented
operation to mark that operation public, or provide a different requirement.

## UI guidance

The JSON document is the stable integration point. The reference page is a
small optional HTML shell, so switching UI providers does not affect API
generation or route authoring.

### Scalar

Use `ui: "scalar"` for a modern reference with request examples and an API
client.

### Swagger UI

Use `ui: "swagger"` for the widely supported Swagger UI renderer. Pracht
enables deep links and disables Swagger's remote validator by default, so
viewing an internal document does not send it to `validator.swagger.io`.

### CDN, CSP, and self-hosting

The built-in shells load pinned browser assets from jsDelivr:

- Scalar `@scalar/api-reference@1.64.0`;
- Swagger UI `swagger-ui-dist@5.32.12`.

This keeps the companion package small, but production applications with
offline requirements or a no-third-party-CDN policy should self-host those
files and override their URLs:

```ts
prachtOpenApi({
  info: { title: "Acme API", version: "1.0.0" },
  ui: {
    provider: "swagger",
    scriptUrl: "/vendor/swagger-ui-bundle.js",
    styleUrl: "/vendor/swagger-ui.css",
  },
});
```

`scriptUrl` is supported for both providers; `styleUrl` is Swagger-only. Copy
the pinned distribution files into `public/vendor/` or provide your own HTML
route if you need deeper UI customization.

The generated shell also contains a small inline initialization script. A
strict CSP must allow that exact script by hash (and the selected asset origin),
or replace the shell with an app-owned page whose bootstrap follows the app's
nonce policy. Self-hosting the provider bundle alone does not make the page
compatible with a `script-src` policy that rejects every inline script.

### Security and deployment

- Treat the document and UI as public unless your hosting layer protects the
  emitted static files. Do not put secrets, internal hostnames, or credentials
  in descriptions or examples.
- Keep the UI and JSON on the same origin. A cross-origin document needs CORS
  headers, and browser restrictions still prevent tools from setting certain
  headers such as `Cookie` directly.
- “Try it out” sends real requests. Protect mutation endpoints with the same
  authentication, authorization, CSRF, rate-limit, and confirmation policies
  as every other client.
- Never embed an OAuth client secret in UI configuration. Browser-delivered
  configuration is observable by every visitor.
- Set appropriate static caching for `/openapi.json`. Immutable asset caching
  is usually wrong unless the URL is versioned or deployments purge it.

## Programmatic generation

`generateOpenApiDocument()` remains available for custom generators and tests.
It accepts live resolved routes (methods are discovered from loaded modules) or
serialized `AppGraphApiRoute` entries:

```ts
const { document, warnings } = await generateOpenApiDocument({
  info: { title: "My API", version: "1.0.0" },
  routes: apiRoutes,
  loadModule: (file) => viteServer.ssrLoadModule(file),
});
```

Raw JSON Schema response bodies work directly. Standard JSON Schema
implementations use their output projection. Pass `resolveSchema` for
libraries that require a separate converter.

## Current boundaries

- Default-export handlers are not expanded because their supported methods
  cannot be inferred honestly.
- Catch-all Pracht paths become a single `{path}` parameter and emit a warning
  about slash encoding.
- Request bodies default to `application/json`; other content types need
  explicit request metadata in a future descriptor revision.
- Capability HTTP projections are not included yet.
- OpenAPI drift checking is expressed through deterministic build output and
  `failOnWarnings`; a dedicated CLI diff/check command is not included yet.
