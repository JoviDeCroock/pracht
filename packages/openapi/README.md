# @pracht/openapi

Opt-in OpenAPI 3.1 generation, development endpoints, static build output, and
reference UI integration for Pracht API routes.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { prachtOpenApi } from "@pracht/openapi/vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [
    pracht(),
    prachtOpenApi({
      info: { title: "My API", version: "1.0.0" },
      ui: "scalar", // false (default), "scalar", or "swagger"
    }),
  ],
});
```

During development, the plugin serves `/openapi.json` and optional `/docs`
endpoints from the live app graph. `pracht build` emits the same resources to
`dist/client/openapi.json` and `dist/client/docs/index.html`, so all Pracht
adapters serve them as static assets.

## Document a route

Wrap `defineApi()` to add operation and response metadata without replacing
its validation or inferred client contract:

```ts
import { defineApi, json } from "@pracht/core";
import { defineOpenApi } from "@pracht/openapi";

export const POST = defineOpenApi(
  defineApi({
    body: createItemSchema,
    handler: ({ body }) => json({ id: createItem(body) }, { status: 201 }),
  }),
  {
    summary: "Create an item",
    tags: ["items"],
    responses: {
      201: { description: "Item created", body: itemSchema },
    },
  },
);
```

Existing `defineApi()` handlers receive best-effort documentation. Unknown
response contracts get a valid `default` response and a warning. Set
`failOnWarnings: true` in `prachtOpenApi()` to require complete contracts in
development and builds.

Pass `document` to `prachtOpenApi()` for shared `servers`, `tags`,
`components.securitySchemes`, reusable schemas, and global security
requirements.

The optional UI uses pinned Scalar or Swagger UI assets from jsDelivr. For an
offline deployment, self-host the assets and configure `ui.scriptUrl` plus
Swagger's `ui.styleUrl`. Strict CSP deployments must additionally allow the
small initialization script by hash or use an app-owned UI page.

See the complete [OpenAPI guide](../../docs/OPENAPI.md) for path configuration,
custom generation, UI choices, deployment security, and current boundaries.
