---
title: Adapters
lead: "Build output and options for each deploy target: Cloudflare Workers, Vercel, Netlify, Node.js, and static hosts."
---

To set up an adapter and deploy, follow [Deployment](/docs/deployment). This page lists what each adapter emits and its options.

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

## Cloudflare Workers

The Worker serves dynamic routes, the `ASSETS` binding serves static files, and regenerated ISG HTML goes to the Workers Cache API.

| Option | Default | Effect |
| --- | --- | --- |
| `cache` | `false` | Serve ISG through Workers Caching (see [below](#isg-and-workers-caching)) |
| `workerEntry` | none | Your own Worker module (see [Composing the Worker](#composing-the-worker)) |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](#context-factory)) |
| `assetsBinding` | `"ASSETS"` | Name of the static assets binding |
| `configPath` | Wrangler's lookup | Wrangler config file, such as one [Void](#deploy-with-void) generates |
| `inspectorPort`, `persistState` | automatic, `.wrangler/state` | Local runtime settings for [concurrent dev servers](#build-output) |

### Wrangler config

The `assets` block in `wrangler.jsonc` controls which requests reach the Worker:

```jsonc [wrangler.jsonc]
{
  "name": "my-app",
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"],
  },
}
```

| Key | Why |
| --- | --- |
| `run_worker_first` | Without it, prerendered pages skip the Worker, which stops ISG, Markdown negotiation, and `headers()` exports. `"!/assets/*"` lets hashed files skip it; their headers go to `dist/client/_headers` |
| `html_handling` | Match [`trailingSlash`](/docs/routing#trailing-slashes): `"drop-trailing-slash"` by default or with `"never"`, `"force-trailing-slash"` with `"always"`. `pracht verify` warns on a mismatch |

`pracht build` copies it to `dist/server/wrangler.json` with `main`, bundling rules, and the assets directory added.

### Build output

```
dist/
  client/          // static assets served via ASSETS binding
    assets/
    index.html     // SSG pages
  server/
    worker.js      // Worker entry: default handler and your entrypoint classes
    server.js      // build metadata for the prerender pass
    wrangler.json  // deploy config generated from wrangler.jsonc
```

With named Wrangler environments, run `CLOUDFLARE_ENV=staging pracht build && wrangler deploy`. Deploying with `--env` instead needs `"main": "dist/server/worker.js"`, `"no_bundle": true`, an `ESModule` rule for `"**/*.js"`, and `assets.directory: "dist/client"` in `wrangler.jsonc`.

To run several dev servers at once, give each its own inspector port and state path, or turn them off:

```ts
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

### ISG and Workers caching

By default, regenerated ISG pages live in each data center's Cache API, so a [webhook](/docs/rendering#webhook-revalidation) refreshes one data center. Set `cache` to render time-revalidated routes on demand and purge them everywhere:

```ts [vite.config.ts]
cloudflareAdapter({ cache: true });

// The stale window defaults to one year.
cloudflareAdapter({ cache: { staleWhileRevalidate: 86_400 } });
```

```jsonc [wrangler.jsonc]
{ "cache": { "enabled": true } }
```

Workers Caching keys on the exact path and query string, so query order and trailing slashes create separate entries; keep ISG query shapes bounded. Cached hits skip middleware, so put per-visitor policy on SSR routes.

### Composing the Worker

For Durable Objects, Cron Triggers, Queue consumers, or code around each request, point `workerEntry` at your own Worker module:

```ts [vite.config.ts]
cloudflareAdapter({ workerEntry: "/src/worker.ts" });
```

```ts [src/worker.ts]
import { createPrachtHandler } from "@pracht/adapter-cloudflare/worker";

export { Counter } from "./workers/counter.ts";

const pracht = createPrachtHandler();

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");

    const response = await pracht.fetch(request, env, ctx);
    const wrapped = new Response(response.body, response);
    wrapped.headers.set("x-served-by", "pracht");
    return wrapped;
  },

  async scheduled(controller, env, ctx) {
    await runCronSweep(env, ctx);
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) await processJob(message, env);
  },
};
```

`pracht.fetch()` serves everything the generated Worker does. The other handlers and named class exports such as Durable Objects deploy as written, and `pracht dev` runs the same module.

Pass `createPrachtHandler({ createContext })` to shape the `context` loaders and API routes receive; it defaults to `{ env, executionContext }`. The `workerExportsFrom`, `workerHandlersFrom`, and `createContextFrom` options cannot be combined with `workerEntry`.

### Local preview and Worker bindings

`pracht preview` builds the Worker and runs `wrangler dev`. Bindings come from a gitignored `.dev.vars` file, not from your shell environment (see [Environment variables](/docs/env#local-environment-files)).

With a custom-domain route in `wrangler.jsonc`, `request.url` carries that domain even on localhost. To preview without the route, run Wrangler with a config that also has the `--env` keys listed under [Build output](#build-output); `pracht preview` does not forward `--config`:

```sh
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

### WebSockets

Only the Cloudflare adapter serves WebSocket upgrades through pracht. Forward the handshake from an [API route](/docs/api-routes#websockets) to a Durable Object, which owns the connection:

```ts [src/workers/chat-room.ts]
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  override async fetch(request: Request) {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server); // hibernation-aware
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    for (const peer of this.ctx.getWebSockets()) peer.send(String(message));
  }
}
```

Upgrades work in `pracht dev` too.

### Accessing Cloudflare bindings

Loaders and API routes receive `env` on the context:

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

Generate an `Env` type from your bindings with `npx wrangler types`, then register it:

```ts [src/env.d.ts]
import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    context: { env: Env; executionContext: ExecutionContext };
  }
}
```

`create-pracht` apps run it as `cf-typegen` and before `typecheck`.

`import { env } from "cloudflare:workers"` also works. In API and capability modules, read `env.DB` inside the handler or `run()`: graph commands load those modules without bindings, and a top-level read fails with the binding's name.

Bindings do not exist while `pracht build` prerenders SSG and ISG pages, so a read there returns `undefined` and the build prints `Warning: Prerendering read env.DB from cloudflare:workers`. Give pages that need bindings `render: "ssr"`, and use the `waitUntil` your loader receives; the one from `cloudflare:workers` throws while prerendering.

### Deploy with Void

[Void](https://void.cloud/integrations/frameworks/overview) deploys apps built with this adapter and adds `void/db`, `void/kv`, cron jobs, and queues. Add `voidPlugin()` before `pracht()` and point `configPath` at the config Void generates:

```ts [vite.config.ts]
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [
    voidPlugin(),
    pracht({ adapter: cloudflareAdapter({ configPath: "./.void-wrangler.jsonc" }) }),
  ],
});
```

Bindings and compatibility flags then live in `void.config.ts` instead of `wrangler.jsonc`; include `nodejs_als` in `compatibility_flags`. `void deploy` runs `pracht build`. Routes whose loaders use `void/*` helpers need `render: "ssr"`, because prerendering runs without bindings.

## Vercel

The adapter writes Vercel's Build Output API v3: SSG pages as static files, SSR and API routes in an Edge Function, and each ISG route in its own Node Serverless Function, where Vercel supports ISR.

| Option | Default | Effect |
| --- | --- | --- |
| `regions` | Vercel's default | Edge Function regions; `"all"` keeps it global while ISG functions use the project's default Serverless region |
| `functionName` | `"render"` | Edge Function name; change it if an ISG route collides with it |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](#context-factory)) |

### Build output

```
.vercel/
  output/
    config.json    // routes, rewrites, headers
    static/        // SSG pages served from the filesystem
    functions/
      render.func/ // Edge Function for SSR/API routes and webhook bridge
      pricing.func/ // Serverless Function for one ISG route
      pricing.prerender-config.json
```

For webhook revalidation, set `PRACHT_REVALIDATE_TOKEN` **at build time**. Vercel embeds it in each ISG route's prerender config, so a token set only at runtime cannot bypass the cache until you rebuild. Time-only ISR does not need it.

Each SSG or ISG page uses one of the 2,048 routes Vercel allows per Hobby or Pro deployment; `pracht build` warns near the limit.

A custom Vercel server entry must export `nodeListener`, built with `createVercelNodeListener(handle)`, so the ISG functions can run the same handler.

## Netlify Functions

The adapter emits a Functions v2 handler and maps ISG to Netlify's durable CDN cache.

| Option | Default | Effect |
| --- | --- | --- |
| `excludedPath` | none | Extra static prefixes Netlify serves without the function; never list page URLs |
| `staleWhileRevalidate` | one year | Seconds stale ISG output is served while Netlify refreshes it; `0` disables |
| `staticMaxAge` | one year | CDN lifetime of SSG documents; `0` for no freshness |
| `functionName` | `"pracht"` | Generated function name |
| `functionsDir` | `netlify/functions` | Where the function wrapper is written |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](#context-factory)) |

The function serves every page URL. `/assets/*`, `/_pracht/*`, and `excludedPath` prefixes bypass it; the build writes their immutable caching and security headers to `dist/client/_headers`. A `public/_headers` file of your own replaces it, and the build warns.

### Caching and revalidation

- SSG documents are cached durably on Netlify's CDN.
- ISG routes use their revalidation window as the CDN `max-age` and serve the stale page while a fresh render runs. Authenticated calls to `/__pracht/revalidate` purge a page's cache tag.
- SSR and API responses with `Cache-Control: public` are cached on the CDN too, unless they set a cookie or vary on `Cookie` or `Authorization`. Set `Netlify-CDN-Cache-Control` to control that; otherwise a `public` `Cache-Control` is copied into it.
- On SSG and ISG pages, your own `Cache-Control`, `CDN-Cache-Control`, or `Netlify-CDN-Cache-Control` overrides these defaults.
- A non-canonical ISG URL redirects to the canonical spelling, so one copy is cached, and unrelated query parameters share its entry. A custom `Netlify-Vary` header replaces pracht's default key.

## Node.js

The adapter runs pracht as a Node.js HTTP server that serves static files and ISG pages. The generated `dist/server/server.js` boots it and listens on `PORT`, or `3000`.

| Option | Default | Effect |
| --- | --- | --- |
| `canonicalOrigin` | none | Public origin for `request.url`; without it, the server warns that the URL comes from the `Host` header |
| `maxBodySize` | 1 MiB | Largest request body accepted |
| `basePathStripped` | `false` | Set when a proxy removes Vite's `base` (see [Sub-path deploys](/docs/deployment#sub-path-deploys)) |
| `compression` | `true` | Brotli or gzip from `Accept-Encoding` |
| `earlyHints` | `false` | Send a `103 Early Hints` response (see [Performance](/docs/performance#early-hints)) |
| `port` | `3000` | Port when `PORT` is unset |
| `shutdownTimeoutMs`, `keepAliveTimeoutMs`, `headersTimeoutMs` | `10000`, Node's defaults | See [Graceful shutdown](#graceful-shutdown) |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](#context-factory)) |
| `configureServerFrom` | none | Module exporting `configureServer(server)` (see [WebSockets](#websockets-1)) |

### Origin, proxy, and body-size options

Pin the public origin so `request.url` never depends on the `Host` header:

```ts [vite.config.ts]
nodeAdapter({
  canonicalOrigin: "https://app.example.com",
  maxBodySize: 10 * 1024 * 1024,
});
```

Behind a trusted proxy that overwrites `Forwarded` or `X-Forwarded-*`, a custom entry can pass `trustProxy: true` to `createNodeRequestHandler()` instead; never on a directly reachable server.

A custom `node:http` server can reuse this handling from `@pracht/adapter-node/bridge`: `createWebRequest(req, res, { maxBodySize, trustProxy, canonicalOrigin })` resolves to a `Request` (its `signal` aborts on disconnect) or to the 413 or 400 `Response` to send, and `writeWebResponse(res, response)` streams the answer.

### Response compression

Responses are compressed with brotli or gzip, and streamed responses such as SSE still arrive incrementally. Already-encoded responses, `Cache-Control: no-transform`, range requests, binary media, and bodies under 1 KiB are sent as-is. If a proxy or CDN in front of the server already compresses, turn it off:

```ts [vite.config.ts]
nodeAdapter({ compression: false });
```

### ISG on several instances

Each server keeps ISG pages in its own `dist/client`, and `POST /__pracht/revalidate` reaches one replica only, so serve ISG routes from a single instance.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the generated server stops accepting connections, ends SSE streams cleanly, lets in-flight requests and [`waitUntil()`](/docs/data-loading#waituntil) work finish, then exits. Open WebSockets hold it until the limit; a second signal exits at once. Keep the limit below your platform's kill grace period:

```ts [vite.config.ts]
nodeAdapter({
  shutdownTimeoutMs: 8_000, // default 10_000
  keepAliveTimeoutMs: 65_000, // above your load balancer's idle timeout; Node's default is 5_000
  headersTimeoutMs: 66_000, // time to receive request headers; Node's default is 60_000
});
```

Custom servers built on `createNodeRequestHandler()` call `await handler.closeEventStreams(timeoutMs)` then `await handler.drain(timeoutMs)` after `server.close()`.

### WebSockets

Upgrade requests never reach pracht on Node. Attach a WebSocket server in a module that exports `configureServer(server)` and point `configureServerFrom` at it; the generated entry calls it before `listen()`, and `pracht dev` calls it too:

```ts [vite.config.ts]
nodeAdapter({ configureServerFrom: "/src/server/websockets.ts" });
```

```ts [src/server/websockets.ts]
import type { Server } from "node:http";
import { WebSocketServer } from "ws";

export function configureServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // This bypasses pracht, so check the Origin header yourself.
    if (req.headers.origin !== process.env.PRACHT_ORIGIN) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
```

The generated entry also exports `handler` and starts a server only when run as the process entrypoint, so `createServer(handler)` in your own entry works too.

## Static export

`@pracht/adapter-static` prerenders every route into `dist/client/`, which works on any static host with no server.

| Option | Default | Effect |
| --- | --- | --- |
| `fallback` | none | Also write an SPA fallback document, such as `"200.html"`, for hosts that rewrite unknown URLs |
| `fallbackHead` | none | `head()` metadata for the fallback document, shared by every rewritten URL |

### What must hold

The build fails, listing every offender, unless:

- Routes are `render: "ssg"`, or loaderless `"spa"` routes with full hydration. Dynamic `ssg` routes export `getStaticPaths()`.
- No middleware, API routes, or capabilities exposed over HTTP, MCP, or WebMCP.
- With `fallback`, the `notFound` page uses full hydration.
- Vite `base` is `/` or a root-absolute path such as `/my-project/`.

### Client navigation from static files

The build writes each full-hydration route's state to `dist/client/_pracht/state/`, and client navigation fetches those files. Islands pages keep full-page navigation.

### 404 and SPA fallback

The `notFound` page is rendered to `404.html` (the GitHub Pages and S3 convention) and adopts the visited URL. With `fallback: "200.html"` plus a host rewrite for unmatched URLs, deep links into dynamic `render: "spa"` routes boot the client router and resolve the route from `window.location`.

#### Dropping the router from `404.html`

On an islands or static site, the client router is the largest chunk in the build, and on `404.html` it only adopts the URL. A 404 with fixed markup can drop it:

```ts
notFound: {
  component: () => import("./routes/not-found.tsx"),
  shell: "site",
  hydration: "none",   // or "islands"
}
```

`useLocation()` then reports the synthetic prerender path, not the visited one. To show the visited URL, read it in an island:

```tsx
// src/islands/RequestedPath.tsx
export default function RequestedPath() {
  return <code>{typeof window === "undefined" ? "" : window.location.pathname}</code>;
}
```

#### How the fallback behaves

- It is one document shared by every rewritten URL, so it cannot run a route's `head()`. If a fallback-rendered route exports one, set a generic `fallbackHead`; the build fails without it.
- A URL that matches a dynamic `ssg` route but was not prerendered by `getStaticPaths()` renders the `notFound` page.
- Unknown URLs get status 200 from the rewrite, so they are soft 404s. Without a `notFound` page or a catch-all SPA route they render blank, and the build warns.

### Host requirements

- Pages are written decoded as `<path>/index.html` (`/posts/caf%C3%A9` → `posts/café/index.html`), so the host must serve `index.html` for directory URLs.
- The host sets response headers. Mirror the ones you need from `dist/server/headers-manifest.json`, which records each route's headers.
- `Accept` negotiation does not apply, so agents read a page's `markdown` export at `/about.md`. Serve `.md` as `text/markdown; charset=utf-8` (nginx's default `mime.types` has no entry for it). The build names Markdown pages that got no `.md` file.

To serve a static export under a sub-path, see [Sub-path deploys](/docs/deployment#sub-path-deploys).

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

Loaders, middleware, and API routes receive the result as `args.context`, in `pracht dev` too, where the Vercel and Netlify `context` holds only `waitUntil`. With a Cloudflare [`workerEntry`](#composing-the-worker), pass `createContext` to `createPrachtHandler()` instead.

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
