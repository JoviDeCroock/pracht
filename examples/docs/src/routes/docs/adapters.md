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
static HTML. An SSG page with a `markdown` export and no middleware also gets a
static `<path>.md` file on every adapter (see [Markdown for agents](/docs/agents#a-md-url-for-static-markdown-pages)).

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

`pracht build` copies this file to `dist/server/wrangler.json`, adding `main`,
bundling rules, and the assets directory, for `wrangler deploy` and
`wrangler dev`. Older configs that set those keys still work.

Without `run_worker_first`, prerendered pages skip the Worker, so ISG, Markdown
negotiation, and `headers()` exports stop; `pracht doctor` warns about it.
`"!/assets/*"` lets hashed files skip it; `pracht build` writes their headers
to `dist/client/_headers`.

### Build output

`pracht build` emits:

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

With named Wrangler environments, run
`CLOUDFLARE_ENV=staging pracht build && wrangler deploy`. Deploying with `--env`
instead needs `"main": "dist/server/worker.js"`, `"no_bundle": true`, an
`ESModule` rule for `"**/*.js"`, and `assets.directory: "dist/client"` in
`wrangler.jsonc`.

To run several dev servers at once, give each its own inspector port and local
state path, or turn them off:

```ts
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

### ISG and Workers Caching

ISG stores regenerated pages in each data center's Cache API by default, so a
[webhook](/docs/rendering#webhook-revalidation) refreshes one data center.
Opt into Cloudflare's edge cache to render time-revalidated routes on demand
and purge them everywhere:

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
unbounded cold renders, so keep ISG query shapes bounded.
Cached hits skip middleware, so per-visitor policy belongs on SSR routes.

Without `assets.html_handling`, the assets binding redirects `/guide` to
`/guide/`, while Node serves `/guide` directly. Set it to match
[`trailingSlash`](/docs/routing#trailing-slashes): `"drop-trailing-slash"`, as
in the config above, by default or with `"never"`, and `"force-trailing-slash"`
with `"always"`. `pracht verify` warns when the two disagree.

### Composing the Worker

When the Worker needs more than pracht's request handling, such as Durable
Objects, Cron Triggers, Queue consumers, or code around each request, write the
Worker module yourself and point `workerEntry` at it:

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

Cron Triggers, Queues, and Email Routing call the default export's methods,
and `pracht.fetch()` serves everything the generated Worker does. Named class
exports such as Durable Objects deploy beside it, with their bindings and
migrations in `wrangler.jsonc`. `pracht dev` runs the same module.

Pass `createPrachtHandler({ createContext })` to shape the `context` loaders
and API routes receive; it defaults to `{ env, executionContext }`. The older
`workerExportsFrom`, `workerHandlersFrom`, and `createContextFrom` options still
work, but not with `workerEntry`.

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
separate config that omits the production route, run Wrangler yourself. It
replaces the generated config, so it needs those keys too:

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

`npx wrangler types` generates an `Env` type from your `wrangler.jsonc`
bindings. Register it to type `context.env`:

```ts [src/env.d.ts]
import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    context: { env: Env; executionContext: ExecutionContext };
  }
}
```

`create-pracht` runs it as `cf-typegen` and before `typecheck`; rerun it after
changing bindings.

`import { env } from "cloudflare:workers"` also works, but in API and
capability modules read `env.DB` inside the handler or `run()`, not at module
top level. Pracht inspects those modules without real bindings, and a top-level
read fails with the binding's name.

Bindings do not exist while `pracht build` prerenders SSG and ISG pages, so a
binding read there returns `undefined` and the build prints
`Warning: Prerendering read env.DB from cloudflare:workers` with every name it
saw. Give pages that need bindings `render: "ssr"`, and use the `waitUntil`
your loader receives rather than the one from `cloudflare:workers`, which
throws while prerendering.

### Deploy

```sh
pracht build
npx wrangler deploy
```

### Deploy with Void

[Void](https://void.cloud/integrations/frameworks/overview) deploys apps built
with this adapter and adds `void/db`, `void/kv`, cron jobs, and queues. Add
`voidPlugin()` before `pracht()` and point the adapter at the Cloudflare
config Void generates:

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

Bindings and compatibility flags then live in `void.config.ts` instead of
`wrangler.jsonc`; include `nodejs_als` in `compatibility_flags`. `void deploy`
runs `pracht build`. Routes whose loaders use `void/*` helpers need
`render: "ssr"`, because prerendering runs without bindings.

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
functions use the project's default Serverless region.

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

Each SSG or ISG page adds one of the 2,048 routes Vercel allows per Hobby or
Pro deployment; `pracht build` warns near that limit.

### Preview and generated functions

`pracht preview` cannot emulate Vercel and exits with guidance: use
`vercel build` and `vercel dev` instead.

The Edge Function is named `render`; set
`vercelAdapter({ functionName: "app" })` if an ISG route collides with it. A custom Vercel server entry must export `nodeListener`, built with
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
- An ISG URL in its non-canonical spelling redirects to the canonical one
  (slashless unless `trailingSlash: "always"`), so only one copy is cached. Unrelated query parameters, such as tracking tags, share the
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

Run pracht as a standard Node.js HTTP server. The adapter serves static files
and ISG pages, and the generated `dist/server/server.js` entry boots it directly.

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

A custom `node:http` server with its own Web handler can reuse this request
handling from `@pracht/adapter-node/bridge`. `createWebRequest(req, res, { maxBodySize, trustProxy, canonicalOrigin })`
resolves to a `Request` whose `signal` aborts when the client disconnects, or
to the 413 or 400 `Response` to send instead. `writeWebResponse(res, response)`
streams the answer.

### Response compression

Responses are compressed by default, negotiated from `Accept-Encoding` with
brotli preferred. Streamed responses such as SSE still arrive incrementally.

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

Each server keeps ISG pages in its own `dist/client`, so
`POST /__pracht/revalidate` reaches one replica only. Serve ISG routes from a
single instance; replicas behind a load balancer drift apart.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the generated server stops accepting connections,
closes SSE streams, lets in-flight requests and
[`waitUntil()`](/docs/data-loading#waituntil) work finish, then exits.
WebSockets hold it until the limit; a second signal exits at once. Keep the
limit below your platform's kill grace period:

```ts [vite.config.ts]
nodeAdapter({
  shutdownTimeoutMs: 8_000, // default 10_000
  keepAliveTimeoutMs: 65_000, // above your load balancer's idle timeout; Node's default is 5_000
  headersTimeoutMs: 66_000, // time to receive request headers; Node's default is 60_000
});
```

Custom servers built on `createNodeRequestHandler()` call
`await handler.closeEventStreams(timeoutMs)` then `await handler.drain(timeoutMs)` after
`server.close()`.

### WebSockets

Upgrade requests go to the server's `upgrade` event and never reach pracht, so
attach a WebSocket server to the same HTTP server. The generated entry exports
`handler`, and only starts its own server when run as the process entrypoint:

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

On that page the client router only adopts the URL, yet on an islands or
static site it is the largest chunk in the build. A 404 with fixed markup can
drop it:

```ts
notFound: {
  component: () => import("./routes/not-found.tsx"),
  shell: "site",
  hydration: "none",   // or "islands"
}
```

The page is prerendered at a synthetic path, so `useLocation()` then reports
that path, not the visited one. To show the visited URL, read it in an island;
`hydration: "islands"` costs a few kB instead of the router:

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

Pages are written decoded as `<path>/index.html`
(`/posts/caf%C3%A9` → `posts/café/index.html`), so the host must serve
`index.html` for directory URLs.

The host sets response headers. Mirror the ones you need from
`dist/server/headers-manifest.json`, which records each route's headers.

A static host always answers `/about` with the HTML file, so `Accept`
negotiation does not apply; agents read a page's `markdown` export at
`/about.md` instead. Make sure the host serves `.md` as
`text/markdown; charset=utf-8` (nginx's default `mime.types` has no entry for
it). The build prints a note naming Markdown pages that got no `.md` file.

To serve a static export under a sub-path, see
[Sub-Path Deploys](/docs/deployment#sub-path-deploys).

---

## Context Factory

To give loaders and API routes platform values, point the adapter at a module that exports `createContext`:

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

// Node also receives { req, res }, without visitor headers on ISG pages.
// Cloudflare receives { request, env, executionContext }.
// Vercel Edge receives { request, context }. Node ISG provides a
// waitUntil-compatible context, without other Edge-only fields.
```

A Cloudflare app with its own [Worker module](#composing-the-worker) passes `createContext` to `createPrachtHandler()` instead. Loaders, middleware, and API routes receive the result as `args.context`, in `pracht dev` too, where the Vercel or Netlify platform `context` holds only `waitUntil`.

---

## Writing a Custom Adapter

A custom adapter exports a factory function that returns a `PrachtAdapter` object. Import the type from `@pracht/core/adapter`, which adds no runtime dependency, so the adapter package needs no edge to the Vite plugin:

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

Graph commands (`pracht inspect`, `plan`, `verify`, `report`, `doctor`, `typegen`)
call `graphVitePlugins()` instead of `vitePlugins()`, or load no adapter plugins
without it.

`finalizeBuild(context)` writes your deploy layout, as the Vercel adapter does for `.vercel/output`. The context holds the build paths, prerendered `pages`, manifests, `buildId`, and `log`/`warn`.

`createServerEntryModule(entry)` receives `entry.buildId`, which is new for every `pracht build`. Key anything your runtime caches across deploys by it, so a new deploy never serves output the previous one rendered.

At the runtime level, an adapter also typically needs to:

1. Accept a platform request and convert it to a Web `Request`
2. Serve static files from `dist/client/` with their headers
3. Serve prerendered SSG/ISG HTML, checking ISG staleness where the platform can
4. Delegate dynamic requests to `handlePrachtRequest()` from `pracht`, passing the platform's `waitUntil`. It resolves each `app` object once, so pass a new `defineApp()` result to change routes at runtime
5. Convert the Web `Response` back to the platform's response format
6. Provide a context factory for platform-specific values

A static-export adapter sets `staticTarget: true` and builds its entry with
`createStaticServerEntryModule()` from `@pracht/adapter-static` for `404.html`
and the SPA fallback.

If your transport sends responses itself, pass them through
`normalizeResponseHeaders()` so bodyless responses (`HEAD`, `204`, `304`) don't
carry a stale `Content-Length`:

```ts
import { normalizeResponseHeaders } from "@pracht/core/server";

const response = normalizeResponseHeaders(
  await handlePrachtRequest({ app, registry, request }),
);
```

> [!INFO]
> See the source of `@pracht/adapter-cloudflare`, `@pracht/adapter-netlify`, or `@pracht/adapter-node` in the monorepo for a concrete reference implementation.
