---
title: Adapters
lead: Adapters are thin layers that translate between a platform's native request handling and pracht's Web Request/Response interface. pracht ships adapters for Cloudflare Workers, Vercel, Netlify, Node.js, and pure static export.
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
  → Is this a prerendered page?  → Yes: serve static HTML or the platform's ISG cache
  → Delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Prerendered pages are served with the same document headers their route and
shell would set on a dynamic response.

ISG pages render on a sanitized request — path only, with no cookies,
credentials, query string, or body — because the result is cached and served
to every visitor. Anything that depends on the visitor belongs on an SSR route.

On Node, Cloudflare, and Netlify, a prerendered route that exports `markdown`
(or sets `markdown: true` when middleware handles negotiation) is served as
Markdown when the request prefers `text/markdown`. Every other request gets the
static HTML.

---

## Cloudflare Workers

Deploy to Cloudflare's global edge network. Static assets are served from the
`ASSETS` binding, dynamic routes are handled by the Worker, and regenerated ISG
HTML is stored in the Workers Cache API with `ASSETS` as the build-time
fallback.

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
    server.js      // Worker bundle used for the build/prerender pass
    worker.js      // clean Wrangler deploy entry
```

Keep your `wrangler.jsonc` in the project root so you can add bindings without
the build overwriting them.

To run several dev servers at once, give each its own inspector port and local
state path, or turn them off:

```ts
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

### ISG and Workers Caching

By default, ISG stores regenerated pages in the per-colo Cache API. Opt into
Cloudflare's cache in front of the Worker when time-revalidated routes should
render on demand at the edge:

```ts [vite.config.ts]
cloudflareAdapter({ cache: true });

// The stale window defaults to one year and is independently configurable.
cloudflareAdapter({ cache: { staleWhileRevalidate: 86_400 } });
```

```jsonc [wrangler.jsonc]
{ "cache": { "enabled": true } }
```

Workers Caching keys on the exact path and query string. Query order and
trailing slashes create separate entries, and arbitrary query values create
unbounded cold renders, so keep query shapes on shared ISG routes bounded.
Cached hits skip middleware, so per-visitor policy belongs on SSR routes.

The assets binding may redirect `/guide` to `/guide/`, while Node serves
`/guide` directly. Set `assets.html_handling` in `wrangler.jsonc` (for example
to `"drop-trailing-slash"`) to keep one canonical URL across adapters.

### Exporting bindings and event handlers

Wrangler discovers class-based primitives such as Durable Objects and
Workflows from named exports on the Worker entry. Point the adapter at a
dedicated module that re-exports them:

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

Queue consumers, Cron Triggers, Email Routing, and similar events are methods
on the Worker's **default export**, not named exports. Export those handlers by
name from a second module and point `workerHandlersFrom` at it:

```ts [vite.config.ts]
cloudflareAdapter({
  workerExportsFrom: "/src/cloudflare.ts",
  workerHandlersFrom: "/src/worker-handlers.ts",
});
```

```ts [src/worker-handlers.ts]
export async function queue(batch, env, ctx) {
  for (const message of batch.messages) await processJob(message, env);
}

export async function scheduled(event, env, ctx) {
  await runCronSweep(env, ctx);
}
```

Pracht merges these methods beside its own `fetch` handler. A `fetch` export in
the handler module is ignored; request handling belongs in API routes or
middleware.

### Local preview and Worker bindings

`pracht preview` builds the Worker and runs `wrangler dev`. Local secrets come
from a gitignored `.dev.vars` file, not from your shell environment; keep
production values in `wrangler secret`.

```dotenv [.dev.vars]
PRACHT_CONFIRMATION_SECRET=local-only-secret
PRACHT_REVALIDATE_TOKEN=local-only-revalidation-token
```

With a custom-domain route in `wrangler.jsonc`, the Worker sees that domain in
`request.url` even though preview listens on localhost. That changes absolute
redirects and Web Bot Auth signatures, which cover `@authority`.

`pracht preview` does not forward Wrangler's `--config` flag. To preview with a
separate config that omits the production route, run Wrangler yourself; that
config must keep `main: "dist/server/worker.js"`:

```sh
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

### WebSockets

Cloudflare is the one adapter that can serve WebSocket upgrades, because a
Durable Object can own a connection for longer than a request. Serve the
handshake from an [API route](/docs/api-routes#websockets) and forward it to the
object:

```ts [src/api/ws.ts]
import type { ApiRouteArgs } from "@pracht/core";

export async function GET({ context, request, url }: ApiRouteArgs) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const { CHAT_ROOM } = context.env as { CHAT_ROOM: DurableObjectNamespace };
  const room = url.searchParams.get("room") ?? "lobby";
  return CHAT_ROOM.get(CHAT_ROOM.idFromName(room)).fetch(request);
}
```

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

Upgrades work in `pracht dev` too. Cross-origin upgrades are rejected by
default, the same way cross-origin mutations are.

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

`import { env } from "cloudflare:workers"` also works, but in API and
capability modules read `env.DB` inside the handler or `run()`, not at module
top level. Pracht inspects those modules without real bindings, and a top-level
read fails with the binding's name.

### Deploy

```sh
pracht build
npx wrangler deploy
```

---

## Vercel

Deploys with Vercel's Build Output API v3. SSG pages are served as static
files, SSR and API routes run in an Edge Function, and each ISG route gets its
own Node Serverless Function, because Vercel supports ISR only on serverless.

### Setup

```ts
// vite.config.ts
import { vercelAdapter } from "@pracht/adapter-vercel";
pracht({ adapter: vercelAdapter() })

// package.json
"@pracht/adapter-vercel": "*"
```

With `vercelAdapter({ regions: "all" })`, the Edge Function stays global and ISG
functions run in the project's default Serverless region, because Serverless
functions need concrete region ids.

For webhook revalidation, `PRACHT_REVALIDATE_TOKEN` must be set **at build
time**: Vercel embeds it in each ISG route's prerender config, so a token set
only at runtime cannot bypass the cache until you rebuild. Time-only ISR does
not need it.

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

### Deploy

```sh
pracht build
npx vercel deploy --prebuilt
```

### Preview and generated functions

Vercel has no faithful local production runtime, so `pracht preview` exits with
guidance instead. Use `vercel build` to reproduce production output and
`vercel dev` for local development.

The Edge Function is named `render` by default. Use
`vercelAdapter({ functionName: "app" })` if an ISG route would collide with
that name. A custom Vercel server entry must export `nodeListener`, built with
`createVercelNodeListener(handle)`, so the ISG functions can run the same
handler.

---

## Netlify Functions

The Netlify adapter emits a fetch-style Functions v2 handler, bundles the
client build for exact static-file serving, and maps ISG to Netlify's durable
CDN cache.

### Setup

```ts [vite.config.ts]
import { netlifyAdapter } from "@pracht/adapter-netlify";

export default defineConfig({
  plugins: [pracht({ adapter: netlifyAdapter() })],
});
```

```toml [netlify.toml]
[build]
  command = "pnpm build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

The generated catch-all function serves page URLs, so Markdown negotiation and
route-state requests reach pracht; `/assets/*` and `/_pracht/*` bypass it. Add
other static prefixes with `netlifyAdapter({ excludedPath: [...] })` — they
stay out of the function bundle too — but never exclude page URLs.

### Caching and revalidation

- SSG documents are cached durably on Netlify's CDN.
- ISG routes use their revalidation window as the CDN `max-age` and serve the
  stale page while a fresh render runs. Authenticated calls to
  `/__pracht/revalidate` purge a page's cache tag.
- SSR and API responses with `Cache-Control: public` are cached on the CDN too,
  unless they set a cookie or vary on `Cookie` or `Authorization`; those stay
  private.
- On SSG and ISG pages, your own `Cache-Control`, `CDN-Cache-Control`, or
  `Netlify-CDN-Cache-Control` takes precedence over these defaults. On SSR and
  API responses, set `Netlify-CDN-Cache-Control` to control CDN caching; a
  `public` `Cache-Control` is otherwise copied into it.
- An ISG URL with a trailing slash redirects to the slashless one, so only one
  copy is cached. Unrelated query parameters, such as tracking tags, share the
  page's cache entry. A custom `Netlify-Vary` header replaces pracht's default
  key.

Because excluded prefixes bypass the function, the build also writes
`dist/client/_headers` with immutable asset caching and pracht's default
security headers. A `public/_headers` file of your own replaces it, and the
build warns.

### Local preview and deploy

```sh
pracht build && netlify dev
netlify deploy --build --prod
```

`pracht preview` does not emulate Netlify's Functions or CDN cache. Build first,
then use `netlify dev` for a platform-shaped local runtime.

---

## Node.js

Run pracht as a standard Node.js HTTP server. The adapter handles static file
serving, ISG stale-while-revalidate, and request translation, and the generated
`dist/server/server.js` entry boots the production server directly.

### Setup

```ts
// vite.config.ts
import { nodeAdapter } from "@pracht/adapter-node";
pracht({ adapter: nodeAdapter() })

// package.json
"@pracht/adapter-node": "*"
```

### Origin, proxy, and body-size options

Pin the public origin in generated Node entries so `request.url` never depends
on an attacker-controlled `Host` header:

```ts [vite.config.ts]
nodeAdapter({
  canonicalOrigin: "https://app.example.com",
  maxBodySize: 10 * 1024 * 1024,
});
```

`maxBodySize` defaults to 1 MiB. Without `canonicalOrigin`, the built server
warns that the URL comes from the `Host` header.

Behind a trusted reverse proxy that overwrites `Forwarded` or `X-Forwarded-*`,
a custom entry can instead pass `trustProxy: true` to
`createNodeRequestHandler()`. Never enable it on a directly reachable server.
If the proxy also strips Vite's deploy base from the path, set
`nodeAdapter({ basePathStripped: true })`.

### Response compression

Responses are compressed by default, negotiated from `Accept-Encoding` with
brotli preferred. Streamed responses such as SSE are flushed chunk by chunk, so
they still arrive incrementally. Static files are compressed once and served
from memory.

Already-encoded responses, `Cache-Control: no-transform`, range requests,
binary media, and bodies under 1 KiB are sent as-is. If a reverse proxy or CDN
in front of the server already compresses, turn it off:

```ts [vite.config.ts]
nodeAdapter({ compression: false });
```

### Deploy

```sh
pracht build
node dist/server/server.js
// Server listening on http://localhost:3000
```

### Graceful shutdown

The generated server handles `SIGTERM` and `SIGINT`: it stops accepting
connections, lets in-flight requests and work registered with
[`waitUntil()`](/docs/data-loading#waituntil) (including background ISG
regeneration) finish, then exits on the same signal. The wait is bounded:

```ts [vite.config.ts]
nodeAdapter({ shutdownTimeoutMs: 25_000 }); // default 10_000
```

Keep it below your platform's kill grace period (Docker and many PaaS hosts
default to 10 seconds, Kubernetes to 30). A custom server built on
`createNodeRequestHandler()` gets the same drain from the handler itself:

```ts [server.ts]
const handler = createNodeRequestHandler({ app, registry /* … */ });
const server = createServer(handler).listen(3000);

process.once("SIGTERM", async () => {
  server.close();
  await handler.drain(10_000); // true when every registered promise settled
  process.exit(0);
});
```

### WebSockets

Node delivers upgrade requests to the server's `upgrade` event, not to the
request handler, so they never reach pracht. Attach a WebSocket server to the
same HTTP server instead. The generated entry exports `handler`, and only
starts its own server when run as the process entrypoint:

```js
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { handler } from "./dist/server/server.js";

const server = createServer(handler);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Check req.headers.origin yourself — this bypasses pracht entirely, so
  // pracht's same-origin protection does not apply.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(3000);
```

---

## Static export

`@pracht/adapter-static` prerenders every route into `dist/client/` and stops
there: no server bundle is deployed, and the directory works on any static
host — GitHub Pages, S3, nginx, Netlify.

### Setup

```ts
// vite.config.ts
import { staticAdapter } from "@pracht/adapter-static";
pracht({ adapter: staticAdapter() })
// optional SPA fallback for host rewrites:
pracht({
  adapter: staticAdapter({
    fallback: "200.html",
    fallbackHead: { title: "My app" }, // shared by every rewritten URL
  }),
})

// package.json
"@pracht/adapter-static": "*"
```

### What must hold

The build checks that the app can run without a server, and fails with a list
of every offender when it can't:

- Routes are `render: "ssg"`, or loaderless `"spa"` routes with full hydration.
  Dynamic `ssg` routes export `getStaticPaths()`.
- No middleware, API routes, or capabilities exposed over HTTP, MCP, or WebMCP.
- With `fallback`, the `notFound` page uses full hydration.
- Vite `base` is `/` or a root-absolute path such as `/my-project/`.

`ssr` and `isg` routes need the Node, Cloudflare, Netlify, or Vercel adapter.

### Client navigation from static files

With no server to answer client-side navigation, the build writes each
full-hydration route's state to `dist/client/_pracht/state/`, and the client
fetches those files instead. Islands pages keep plain full-page navigation.

### 404 and SPA fallback

The app's `notFound` page is rendered to `404.html` (the GitHub Pages / S3
convention), and the full-hydration page adopts the URL actually visited. With
`fallback: "200.html"` plus a host rewrite for unmatched URLs, deep links into
dynamic `render: "spa"` routes boot the client router and resolve the route
from `window.location`.

#### Dropping the router from `404.html`

Adopting the URL is the only thing the client router does on that page, and on
a site whose other pages are islands or static it is the single largest chunk
in the build — requested by `404.html` and nothing else. A 404 that shows fixed
markup does not need it:

```ts
notFound: {
  component: () => import("./routes/not-found.tsx"),
  shell: "site",
  hydration: "none",   // or "islands"
}
```

The tradeoff is the URL. The page is prerendered at a synthetic path, so
`useLocation()` reports that path rather than the one the visitor typed. Say
nothing about the URL, or read it in an island — `hydration: "islands"` costs
the islands bootstrap (a few kB) instead of the router:

```tsx
// src/islands/RequestedPath.tsx
export default function RequestedPath() {
  return <code>{typeof window === "undefined" ? "" : window.location.pathname}</code>;
}
```

This does not work with `fallback`, which needs a full-hydration `notFound`
page.

#### How the fallback behaves

- It is one document shared by every rewritten URL, so it can't run a route's
  `head()`. If a fallback-rendered route exports one, set a generic
  `fallbackHead`; the build fails without it.
- A URL that matches a dynamic `ssg` route but wasn't prerendered by
  `getStaticPaths()` renders the `notFound` page.
- Unknown URLs get status 200 from the rewrite, so they are soft 404s. Without
  a `notFound` page or a catch-all SPA route they render blank, and the build
  warns.

### Build, preview, deploy

```sh
pracht build      # dist/client/ is the deployable site
pracht preview    # serves dist/client/ with a tiny static file server
```

Pages are written as `<path>/index.html`, so the host must serve `index.html`
for directory URLs (clean URLs). Paths are written decoded
(`/posts/caf%C3%A9` → `posts/café/index.html`), matching how static hosts look
files up.

The host, not pracht, sets response headers. The headers each route would have
sent are recorded in `dist/server/headers-manifest.json`; mirror the ones you
need in the host's config.

A static host always answers with the HTML file, so routes that export
`markdown` lose `Accept` negotiation; the build prints a note. Publish `.md`
files under `public/` when a raw-Markdown corpus matters.

To serve a static export under a sub-path, see
[Sub-Path Deploys](/docs/deployment#sub-path-deploys).

---

## Context Factory

Adapters inject platform-specific values into loaders and API routes via a context factory. With generated entries, point the adapter at a module that exports `createContext`:

```ts [vite.config.ts]
nodeAdapter({ createContextFrom: "/src/server/context.ts" });
cloudflareAdapter({ createContextFrom: "/src/server/context.ts" });
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
// Vercel Edge receives { request, context }. Node ISG provides a
// waitUntil-compatible context, without other Edge-only fields.
```

The context object is available as `args.context` in every loader, middleware, and API route handler.

To run work after the response, use `args.waitUntil(promise)` rather than
reaching into `executionContext` or the platform context — it is the same call
on every adapter. See [Data Loading → `waitUntil`](/docs/data-loading#waituntil).

---

## Writing a Custom Adapter

A custom adapter exports a factory function that returns a `PrachtAdapter` object:

```ts
import type { PrachtAdapter } from "@pracht/vite-plugin";
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
  };
}
```

`pracht inspect`, `plan`, `verify`, `report`, `doctor`, and `typegen` never load
an adapter's `vitePlugins()`. They call `graphVitePlugins()` instead, or load no
adapter plugins when it is omitted.

At the runtime level, an adapter also typically needs to:

1. Accept a platform request and convert it to a Web `Request`
2. Check for static assets -- serve files from `dist/client/` with appropriate headers
3. Check for prerendered pages -- serve SSG/ISG HTML (with staleness checking for ISG when the platform supports it)
4. Delegate dynamic requests to `handlePrachtRequest()` from `pracht`, passing
   the platform's `waitUntil` (or a `createWaitUntilTracker()` from
   `@pracht/core/server` that your shutdown drains) as `waitUntil`
5. Convert the Web `Response` back to the platform's response format
6. Provide a context factory for platform-specific values
7. Export an entry module generator for the Vite plugin

A static-export adapter sets `staticTarget: true` and builds its entry with
`createStaticServerEntryModule()` from `@pracht/adapter-static`, so the build
can render `404.html` and the SPA fallback.

If your transport sends responses itself, pass them through
`normalizeResponseHeaders()` so bodyless responses (`HEAD`, `204`, `304`) don't
carry a stale `Content-Length`. It leaves protocol-switch responses, such as
Cloudflare's WebSocket `101`, untouched:

```ts
import { normalizeResponseHeaders } from "@pracht/core/server";

const response = normalizeResponseHeaders(
  await handlePrachtRequest({ app, registry, request }),
);
```

> [!INFO]
> See the source of `@pracht/adapter-cloudflare`, `@pracht/adapter-netlify`, or `@pracht/adapter-node` in the monorepo for a concrete reference implementation.
