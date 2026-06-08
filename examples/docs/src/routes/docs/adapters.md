---
title: Adapters
lead: Adapters are thin layers that translate between a platform's native request handling and pracht's Web Request/Response interface. pracht ships adapters for Cloudflare Workers, Vercel Edge Functions, Void, and Node.js.
breadcrumb: Adapters
prev:
  href: /docs/deployment
  title: Deployment
next:
  href: /docs/prefetching
  title: Prefetching
---

## Architecture

Every adapter follows the same request flow:

```
Platform request (Node / CF / Vercel)
  → Convert to Web Request
  → Is this a static asset?  → Yes: serve from dist/client/
  → Is this a prerendered page?  → Yes: serve static HTML (Node checks ISG staleness)
  → Delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Adapters also preserve route and shell document headers for prerendered HTML so static SSG/ISG responses match dynamic document responses.

---

## Cloudflare Workers

Deploy to Cloudflare's global edge network. Static assets are served from the `ASSETS` binding, and dynamic routes are handled by the Worker. Runtime ISG revalidation is not implemented for Cloudflare yet; ISG routes are prerendered at build time and served as static assets, and `pracht build` warns when this combination is used.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

```json [package.json]
{
  "dependencies": {
    "@pracht/core": "*",
    "@pracht/adapter-cloudflare": "*"
  }
}
```

### Build output

Running `pracht build` with the Cloudflare adapter emits:

```
dist/
  client/          // static assets served via ASSETS binding
    assets/
    index.html     // SSG pages
  server/
    server.js      // Worker bundle
```

Prerendered HTML receives document headers from the generated `_pracht/headers.json` asset.

Keep your `wrangler.jsonc` in the project root so you can add bindings without the build overwriting them.

### Exporting Durable Objects and other primitives

Wrangler discovers Durable Objects, Workflows, Queues, and similar primitives
from named exports on the Worker entry. Point the adapter at a dedicated module
that re-exports them:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        workerExportsFrom: "/src/cloudflare.ts",
      }),
    }),
  ],
});
```

```ts [src/cloudflare.ts]
export { Counter } from "./workers/counter.ts";
```

Keep the matching bindings and migrations in `wrangler.jsonc`.

### Accessing Cloudflare bindings

The `env` object is passed through to your loaders and API routes via the context:

```ts
// src/routes/dashboard.tsx
export async function loader({ context }: LoaderArgs) {
  // context.env is the Cloudflare env object
  const user = await context.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return { user };
}
```

### Deploy

```sh
pracht build
npx wrangler deploy
```

---

## Vercel Edge Functions

Deploy using Vercel's Build Output API v3. SSG pages are served from the static file system; SSR and ISG routes go through the Edge Function.

### Setup

```ts
// vite.config.ts
import { vercelAdapter } from "@pracht/adapter-vercel";
pracht({ adapter: vercelAdapter() })

// package.json
"@pracht/adapter-vercel": "*"
```

Static prerendered routes receive document headers through the generated Build Output `headers` config.

### Build output

```
.vercel/
  output/
    config.json    // routes, rewrites, headers
    static/        // SSG pages served from the filesystem
    functions/
      render.func/ // Edge Function for SSR/ISG/API routes
```

### Deploy

```sh
pracht build
npx vercel deploy --prebuilt
```

---

## Void

Deploy to Void with Pracht's routing/runtime and Void's Cloudflare-backed
deployment platform. The generated Worker wraps requests in Void's runtime env
context, so helpers like `void/db`, `void/kv`, `void/storage`, and `void/env`
can resolve default bindings during loaders and API routes.

Void-managed auth routes are not automatic because Pracht still owns routing.
Wire auth through Pracht API routes and middleware, or use Better Auth directly.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { voidAdapter } from "@pracht/adapter-void";

export default defineConfig({
  plugins: [pracht({ adapter: voidAdapter() })],
});
```

```json [package.json]
{
  "dependencies": {
    "@pracht/core": "*",
    "@pracht/adapter-void": "*",
    "void": "*"
  }
}
```

```json [void.json]
{
  "$schema": "./node_modules/void/schema.json",
  "worker": {
    "compatibility_date": "2026-02-24",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

### Bindings

Void can infer bindings from imports such as `void/db`, `void/kv`, and
`void/storage`, or from direct `env.DB`, `env.KV`, and `env.STORAGE` access. In
Pracht loaders and API routes, raw bindings are always available through
`context.env`:

```ts
export async function loader({ context }: LoaderArgs) {
  const row = await context.env.DB.prepare("SELECT 1 as ok").first();
  return { ok: row?.ok === 1 };
}
```

You can also use Void helpers once the adapter has wrapped the request env:

```ts
import { kv } from "void/kv";

export async function GET() {
  return Response.json({ value: await kv.get("example") });
}
```

### Deploy

```sh
pracht build
void deploy --skip-build
```

---

## Node.js

Run pracht as a standard Node.js HTTP server. The adapter handles static file serving, ISG stale-while-revalidate, request translation, and the generated `dist/server/server.js` entry boots the production server directly.

Prerendered HTML receives document headers from `dist/server/headers-manifest.json`.

### Setup

```ts
// vite.config.ts
import { nodeAdapter } from "@pracht/adapter-node";
pracht({ adapter: nodeAdapter() })

// package.json
"@pracht/adapter-node": "*"
```

### Deploy

```sh
pracht build
node dist/server/server.js
// Server listening on http://localhost:3000
```

---

## Context Factory

Adapters inject platform-specific values into loaders and API routes via a context factory. With generated entries, point the adapter at a module that exports `createContext`:

```ts [vite.config.ts]
nodeAdapter({ createContextFrom: "/src/server/context.ts" });
cloudflareAdapter({ createContextFrom: "/src/server/context.ts" });
voidAdapter({ createContextFrom: "/src/server/context.ts" });
vercelAdapter({ createContextFrom: "/src/server/context.ts" });
```

```ts [src/server/context.ts]
// Node: inject a database pool
export function createContext({ request }: { request: Request }) {
  return {
    db: pool,
    ip: request.headers.get("x-forwarded-for"),
  };
}

// Cloudflare receives { request, env, executionContext }.
// Vercel receives { request, context }.
```

The context object is available as `args.context` in every loader, middleware, and API route handler.

---

## Writing a Custom Adapter

A custom adapter exports a factory function that returns a `PrachtAdapter` object:

```ts
import type { PrachtAdapter } from "@pracht/vite-plugin";

export function myAdapter(): PrachtAdapter {
  return {
    id: "my-platform",
    serverImports:
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return `
export default async function handle(request) {
  return handlePrachtRequest({
    app: resolvedApp,
    registry,
    request,
    apiRoutes,
    clientEntryUrl: clientEntryUrl ?? undefined,
    cssManifest,
    jsManifest,
  });
}
`;
    },
  };
}
```

At the runtime level, an adapter also typically needs to:

1. Accept a platform request and convert it to a Web `Request`
2. Check for static assets -- serve files from `dist/client/` with appropriate headers
3. Check for prerendered pages -- serve SSG/ISG HTML (with staleness checking for ISG when the platform supports it)
4. Delegate dynamic requests to `handlePrachtRequest()` from `pracht`
5. Convert the Web `Response` back to the platform's response format
6. Provide a context factory for platform-specific values
7. Export an entry module generator for the Vite plugin

> [!INFO]
> See the source of `@pracht/adapter-cloudflare` or `@pracht/adapter-node` in the monorepo for a concrete reference implementation.
