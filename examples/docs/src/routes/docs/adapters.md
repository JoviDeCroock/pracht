---
title: Adapters
lead: How every adapter serves a request, how to pass platform values into loader context, and how to write an adapter for a new platform.
---

To set up an adapter and deploy, follow [Deployment](/docs/deployment). Each platform's build output and options have their own page: [Cloudflare Workers](/docs/adapters/cloudflare), [Node.js](/docs/adapters/node), [Vercel and Netlify](/docs/adapters/vercel-netlify), and [Static export](/docs/adapters/static). This page covers what every adapter shares.

## Request flow

Every adapter handles a request the same way:

```
Platform request (Node / CF / Vercel)
  → Convert to Web Request
  → Is this a static asset?  → Yes: serve from dist/client/
  → Is this a prerendered page?  → Yes: serve static HTML or the platform's ISG cache
  → Delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Prerendered pages get the headers their route and shell set on a dynamic response. ISG pages render on a request with only the path (no cookies, credentials, query, or body) because every visitor gets the result; put visitor-dependent output on SSR routes. A render that sets a cookie or marks itself private is never cached.

On Node, Cloudflare, and Netlify, a prerendered route that exports `markdown` is served as Markdown when the request prefers `text/markdown`. An SSG page with a `markdown` export and no middleware also gets a static `<path>.md` file on every adapter (see [Markdown for agents](/docs/agents#a-md-url-for-static-markdown-pages)).

## Context factory

To give loaders and API routes platform values, point `createContextFrom` at a module that exports `createContext`:

```ts [vite.config.ts]
nodeAdapter({ createContextFrom: "/src/server/context.ts" });
cloudflareAdapter({ createContextFrom: "/src/server/context.ts" });
vercelAdapter({ createContextFrom: "/src/server/context.ts" });
netlifyAdapter({ createContextFrom: "/src/server/context.ts" });
```

```ts [src/server/context.ts]
// Node: inject a database pool
export function createContext({ request }: { request: Request }) {
  return {
    db: pool,
    ip: request.headers.get("x-forwarded-for"),
  };
}
```

| Adapter | `createContext` receives |
| --- | --- |
| Node | `{ request, req, res }`; ISG renders get a `req` without visitor headers |
| Cloudflare | `{ request, env, executionContext }` |
| Vercel | `{ request, context }`; Node ISG functions provide a `waitUntil`-compatible `context` only |
| Netlify | `{ request, context }` |

Loaders, middleware, and API routes receive the result as `args.context`, in `pracht dev` too, where the Vercel and Netlify `context` holds only `waitUntil`. With a Cloudflare [`workerEntry`](/docs/adapters/cloudflare#composing-the-worker), pass `createContext` to `createPrachtHandler()` instead.

## Writing a custom adapter

A custom adapter exports a factory that returns a `PrachtAdapter`, a type-only import from `@pracht/core/adapter`:

```ts
import type { PrachtAdapter } from "@pracht/core/adapter";
import { myPlatformGraphStubs, myPlatformVitePlugin } from "my-platform-vite-plugin";

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
    vitePlugins() {
      return myPlatformVitePlugin({ entry: "virtual:pracht/server" });
    },
    // Graph commands call this hook instead of vitePlugins(). Only return
    // metadata helpers or safe runtime-module stubs; never start a runtime.
    graphVitePlugins() {
      return myPlatformGraphStubs();
    },
    async finalizeBuild(context) {
      await writeMyPlatformOutput(context);
    },
  };
}
```

| Hook | Called by | Purpose |
| --- | --- | --- |
| `createServerEntryModule(entry)` | `pracht build` | Server entry source. Key anything cached across deploys by `entry.buildId`, which differs on every build |
| `vitePlugins()` | `pracht dev`, `pracht build` | Platform Vite plugins |
| `graphVitePlugins()` | `inspect`, `plan`, `verify`, `report`, `doctor`, `typegen` | Safe stubs; without it these commands load no adapter plugins |
| `finalizeBuild(context)` | `pracht build` | Writes the deploy layout from build paths, prerendered `pages`, manifests, and `buildId` |

At runtime, follow the [request flow](#request-flow): serve static files and prerendered HTML with their headers, then call `handlePrachtRequest()` from `@pracht/core` with the platform's `waitUntil` and context. It resolves each `app` object once; pass a new `defineApp()` result to change routes.

A static-export adapter sets `staticTarget: true` and builds its entry with `createStaticServerEntryModule()` from `@pracht/adapter-static` for `404.html` and the SPA fallback.

If your transport sends responses itself, pass them through `normalizeResponseHeaders()` so bodyless responses (`HEAD`, `204`, `304`) do not carry a stale `Content-Length`:

```ts
import { normalizeResponseHeaders } from "@pracht/core/server";

const response = normalizeResponseHeaders(
  await handlePrachtRequest({ app, registry, request }),
);
```
