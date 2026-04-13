---
title: Adapters
lead: Adapters are thin layers that translate between a platform's native request handling and pracht's Web Request/Response interface. pracht ships adapters for Cloudflare Workers, Vercel Edge Functions, and Node.js.
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
  → Is this a prerendered page?  → Yes: serve static HTML (check ISG staleness)
  → Delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Adapters also preserve route and shell document headers for prerendered HTML so static SSG/ISG responses match dynamic document responses.

---

## Cloudflare Workers

Deploy to Cloudflare's global edge network. Static assets are served from the `ASSETS` binding, and dynamic routes are handled by the Worker.

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

Adapters inject platform-specific values into loaders and API routes via a context factory. This is where you connect database clients, environment bindings, and other platform resources:

```ts
// Node: inject a database pool
createContext: ({ request }) => ({
  db: pool,
  ip: request.headers.get("x-forwarded-for"),
});

// Cloudflare: expose env bindings
createContext: ({ request, env, executionContext }) => ({
  db: env.DB, // D1 binding
  kv: env.CACHE, // KV binding
  r2: env.STORAGE, // R2 binding
  waitUntil: executionContext.waitUntil.bind(executionContext),
});
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
3. Check for prerendered pages -- serve SSG/ISG HTML (with staleness checking for ISG)
4. Delegate dynamic requests to `handlePrachtRequest()` from `pracht`
5. Convert the Web `Response` back to the platform's response format
6. Provide a context factory for platform-specific values
7. Export an entry module generator for the Vite plugin

> [!INFO]
> See the source of `@pracht/adapter-cloudflare` or `@pracht/adapter-node` in the monorepo for a concrete reference implementation.
