# Deployment Adapters

Adapters bridge pracht's platform-agnostic core to specific deployment targets.
Each adapter is a thin layer that translates between the platform's request
handling and pracht's Web Request/Response interface.

---

## Architecture

```
Platform Request (e.g. Node IncomingMessage, Worker/Function fetch)
  → Adapter converts to Web Request
  → Adapter checks: is this a static asset?
    → Yes: serve from dist/client/
    → No: is this a prerendered SSG/ISG page?
      → Yes: serve static HTML (check ISG staleness)
      → No: delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Every adapter implements this same flow. The differences are in how static files
are served and how ISG revalidation state is tracked.

For page routes, adapters must preserve the distinction between document
requests and route-state fetches (`x-pracht-route-state-request: 1` or
`?_data=1`). Cached or prerendered HTML should never satisfy a route-state
fetch, and HTML responses should vary on that header when both
representations can exist for the same URL. Prerendered HTML also carries
route and shell document headers from the build header manifest so static
responses match dynamic document responses.

---

## Adapter Interface

Each adapter exports three things:

### 1. Adapter factory (for the Vite plugin)

```typescript
// Example: Node adapter
import { nodeAdapter } from "@pracht/adapter-node";

pracht({ adapter: nodeAdapter() });
```

The factory returns a `PrachtAdapter` object that the Vite plugin uses to
generate the server entry module.

### 2. Request handler factory

```typescript
// Example: Node adapter
export function createNodeRequestHandler<TContext>(
  options: NodeAdapterOptions<TContext>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```

### 3. Entry module generator (for custom adapters)

```typescript
export function createNodeServerEntryModule(options?: NodeServerEntryModuleOptions): string;
```

The adapter factory calls the entry module generator internally to create a virtual module
(`virtual:pracht/server`) that bootstraps the server.

---

## Node Adapter (Phase 1)

### `createNodeRequestHandler(options)`

| Option          | Type                 | Description                                                     |
| --------------- | -------------------- | --------------------------------------------------------------- |
| `app`           | `PrachtApp`          | The resolved app from `defineApp()`                             |
| `registry`      | `ModuleRegistry`     | Lazy module importers                                           |
| `staticDir`     | `string`             | Path to `dist/client/`                                          |
| `viteManifest`  | `ViteManifest`       | Client asset manifest for injection                             |
| `createContext` | `(args) => TContext` | App-level context factory                                       |
| `trustProxy`    | `boolean`            | Honor forwarded headers for URL construction (default: `false`) |
| `canonicalOrigin` | `string`           | Fixed public origin for `request.url`; ignores request Host values |
| `maxBodySize`   | `number`             | Maximum request body size in bytes (default: 1 MiB)             |

### Trusted proxy configuration

Set `canonicalOrigin` to pin `request.url` to your known public origin and
avoid depending on `Host` / forwarded host headers at all. Absolute-form
(`http://...`) and network-path (`//...`) request targets are normalized to
path/query/hash before resolving against the canonical origin:

```typescript
createNodeRequestHandler({
  app: resolvedApp,
  registry,
  staticDir,
  canonicalOrigin: "https://app.example.com",
});
```

Without `canonicalOrigin`, the Node adapter derives the request URL from the
socket: protocol is inferred from TLS state, and host from the `Host` header.
Forwarded headers (`Forwarded`, `X-Forwarded-Proto`, `X-Forwarded-Host`) are
**ignored** unless `trustProxy: true` is enabled. Built Node apps warn when no
`canonicalOrigin` is configured, because app code that reads `request.url` can
otherwise inherit attacker-controlled `Host` values in misconfigured
deployments.

Set `trustProxy: true` when the Node server sits behind a trusted reverse proxy
(nginx, Cloudflare, a load balancer, etc.) that sets forwarded headers:

```typescript
createNodeRequestHandler({
  app: resolvedApp,
  registry,
  staticDir,
  trustProxy: true,
});
```

When enabled, header precedence is:

1. **RFC 7239 `Forwarded`** header (`proto=` and `host=` directives)
2. **`X-Forwarded-Proto`** / **`X-Forwarded-Host`**
3. Socket-derived values (fallback)

> **Security note:** `canonicalOrigin` is the safest option when your app uses
> `request.url` to build absolute URLs. If you rely on `trustProxy`, only
> enable it behind a proxy that overwrites forwarded headers.

### Features

- **Static file serving**: reads from `dist/client/` with proper content-type
  headers. Hashed assets under `/assets/` get `Cache-Control: public,
max-age=31536000, immutable`; HTML and other files get `public, max-age=0,
must-revalidate`. Clean URLs (e.g. `/about`) resolve to `about/index.html`.
Prerendered HTML receives route and shell document headers from
`dist/server/headers-manifest.json`. Exact routes with raw Markdown
representations are recorded separately in `dist/server/markdown-manifest.json`.
SSG/ISG prerendering rejects dangerous
document headers such as `Set-Cookie`, `Authorization`, `Proxy-Authenticate`,
`WWW-Authenticate`, and secret-shaped custom `x-*` headers before they can enter
that manifest.
- **ISG revalidation**: checks `isg-manifest.json` for time and webhook
  revalidation metadata. Time revalidation compares file mtime against the
  configured window, serves stale HTML immediately, and refreshes the file in
  the background. Webhook revalidation is exposed at
  `POST /__pracht/revalidate` and regenerates named paths synchronously after
  authenticating `PRACHT_REVALIDATE_TOKEN`. Route-state requests
  (`x-pracht-route-state-request` and `?_data=1`) bypass the cached HTML path
  so client navigation still reaches `handlePrachtRequest()`. All regeneration
  uses a clean HTML request instead of replaying the triggering user's cookies,
  authorization headers, locale, or experiment headers. Static and ISG files are
  streamed, and static responses support `ETag` / `Last-Modified` conditional
  revalidation.
- **Vite manifest**: reads `.vite/manifest.json` to inject correct `<script>` and
  `<link>` tags into server-rendered HTML.
- **Response headers**: preserves multiple `Set-Cookie` headers from framework
  responses by writing them as an array to Node's `ServerResponse`.

### WebSockets

Pracht's Node handler cannot serve WebSocket upgrades, and this is a property of
Node rather than a gap in the adapter: `http.Server` routes upgrade requests to
its `upgrade` event, not to the request handler, so a handshake never reaches
`handler(req, res)` at all. (With no `upgrade` listener attached, Node closes
those connections.)

Attach a WebSocket server to the same HTTP server instead. The
`configureServerFrom` entry option is the supported hook: it names a module
whose `configureServer(server)` export the generated entry calls (and awaits)
with the underlying `http.Server` after `createServer()` and before
`listen()`:

```typescript
// vite.config.ts
nodeAdapter({ configureServerFrom: "/src/server/websockets.ts" });
```

```typescript
// src/server/websockets.ts
import type { Server } from "node:http";
import { WebSocketServer } from "ws";

export function configureServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // Check the Origin header yourself here: browsers do not apply CORS to
    // WebSocket, so a cross-site page can otherwise open an authenticated
    // socket (cross-site WebSocket hijacking). Pracht's own
    // `api.requireSameOrigin` check cannot help — this never reaches pracht.
    if (req.headers.origin !== process.env.PRACHT_ORIGIN) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    ws.on("message", (message) => ws.send(String(message)));
  });
}
```

The generated entry only calls `createServer()` when it is the process
entrypoint, so importing `handler` and building the server yourself remains
supported — attach the same `upgrade` listener to your own
`createServer(handler)` in that case.

For upgrades served *through* pracht's routing (as an API route), use the
[Cloudflare adapter](#websockets-1). The Vercel adapter cannot serve them
either. For server→client streaming that works on every adapter — including
this one — use Server-Sent Events via `createEventStream()` from
`@pracht/core/server` (see the Streaming recipe in the docs app,
`examples/docs/src/routes/docs/recipes-streaming.md`): an SSE response is an
ordinary streaming `Response`, which the Node handler pipes without any of
the upgrade machinery.

### Generated entry options

When using `nodeAdapter()` in `vite.config.ts`, generated entries can import a context factory, tune body limits, and hook the underlying HTTP server:

```typescript
nodeAdapter({
  createContextFrom: "/src/server/context.ts",
  maxBodySize: 10 * 1024 * 1024,
  configureServerFrom: "/src/server/websockets.ts",
});
```

The context module must export `createContext(args)`. Node passes `{ request, req, res }`.
The configure module must export `configureServer(server)` (sync or async); it
runs with the `node:http` server before `listen()` when the generated entry is
the process entrypoint — see [WebSockets](#websockets) above.

### Entry module

Generated by the Vite plugin:

```javascript
// virtual:pracht/node-server (generated)
import { createNodeRequestHandler } from "@pracht/adapter-node";
// ... resolved app, registry, asset manifest, ISG manifest setup

export const handler = createNodeRequestHandler({
  app: resolvedApp,
  registry,
  staticDir,
  isgManifest,
  headersManifest,
  apiRoutes,
  clientEntryUrl,
  cssManifest,
});

// Starts the HTTP server only when `node dist/server/server.js` runs directly.
```

Running `pracht build` for a Node target emits `dist/server/server.js`, which is
the executable production server entry. `pracht preview` builds and runs it in
one step (`--port`/`$PORT` select the port, `--skip-build` reuses the existing
build).

---

## Cloudflare Adapter (Phase 2)

### `createCloudflareFetchHandler(options)`

| Option          | Type                                        | Description                                                          |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `app`           | `PrachtApp`                                 | The resolved app                                                     |
| `registry`      | `ModuleRegistry`                            | Module importers                                                     |
| `createContext` | `(args: CloudflareContextArgs) => TContext` | Context with `env` and `executionContext`                            |
| `isgManifest`   | `Record<string, ISGManifestEntry>`          | Concrete ISG path metadata                                           |
| `cache`         | `boolean \| { staleWhileRevalidate }`       | Serve time-revalidated ISG routes through Workers Caching (see below) |

### Features

- **Asset serving**: uses `env.ASSETS.fetch()` binding for static files
  (Cloudflare handles caching and CDN distribution). Static responses inherit
  the same default security headers applied to dynamic responses.
  Prerendered HTML also receives route and shell document headers from
  `dist/client/_pracht/headers.json`.
- **ISG revalidation**: runtime ISG uses the Workers Cache API as the
  regenerated-page store, with `env.ASSETS` as the build-time fallback. The
  generated worker reads `dist/client/_pracht/isg.json`, checks cache freshness
  from the stored generation timestamp, serves stale HTML immediately for
  time-based revalidation, and schedules regeneration with
  `executionContext.waitUntil()`. `POST /__pracht/revalidate` authenticates
  `PRACHT_REVALIDATE_TOKEN` and overwrites the named Cache API entries for
  routes that opt into `webhookRevalidate()`. Successful manifest reads are
  cached for the isolate lifetime; transient asset or JSON failures are evicted
  so the next request retries. A missing manifest (`404`) is cached as empty.
- **Cache locality**: Cloudflare's Cache API is local to the colo handling the
  request. This keeps ISG dependency-free and fast, but webhook invalidation is
  not a global purge. Other colos refresh when they receive the webhook or when
  their cached entry becomes stale and a visitor requests it.
- **ISG via Workers Caching**: with `cloudflareAdapter({ cache: true })`,
  time-revalidated ISG routes are instead rendered on demand and cached in
  front of the Worker by
  [Workers Caching](https://developers.cloudflare.com/workers/cache/) for
  their `revalidate` window, with stale pages served instantly while the
  Worker re-renders in the background — a true edge-tier cache rather than
  the per-colo Cache API. Webhook-only ISG routes keep the worker-managed
  path above so `POST /__pracht/revalidate` takes effect immediately; when a
  route has both a time and a webhook policy, the webhook also purges the
  edge entry.
- **Default request context**: generated worker entries pass `{ env,
  executionContext }` to pracht so loaders, API routes, and middleware can
  access bindings without extra wiring.
- **Build output**: `pracht({ adapter: cloudflareAdapter() })` makes `pracht build`
  emit a Worker bundle in `dist/server/server.js` plus a thin deploy entry in
  `dist/server/worker.js` that re-exports only the default handler and your
  Cloudflare entrypoint classes (workerd rejects the build metadata that
  `server.js` also exports for the prerender pass). Point `wrangler.jsonc`'s
  `main` at `dist/server/worker.js` — you own that file, which lets you add
  KV, D1, R2, cron, and any other Cloudflare bindings without losing them on
  rebuild.
- **Local preview**: `pracht preview` runs `pracht build` and then delegates to
  `wrangler dev --port <port>` against the built worker. It requires wrangler
  (in `node_modules` or on PATH) and a wrangler config; it errors with install
  instructions otherwise. Wrangler supplies Worker bindings: put local-only
  values such as `PRACHT_CONFIRMATION_SECRET` and
  `PRACHT_REVALIDATE_TOKEN` in a gitignored `.dev.vars` file. Prefixing the
  host command with an environment variable does not automatically expose it
  on the Worker's `env` binding.
- **KV/D1/R2 support**: custom context factories and the default build entry both
  surface the Cloudflare `env` object.
- **`@cloudflare/vite-plugin` integration**: the adapter automatically includes
  `@cloudflare/vite-plugin`, running the dev server inside workerd so that API
  routes and loaders have full access to Cloudflare bindings (KV, D1, R2,
  Queues, etc.) during development.

Cloudflare chooses a local inspector port automatically in dev. If multiple
Vite dev servers can start concurrently, their availability probes can race;
assign each one a distinct port (or disable the inspector) through the adapter.
Local binding state also needs a distinct persistence path or must be disabled:

```typescript
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

### ISG via Workers Caching (`cache`)

[Workers Caching](https://developers.cloudflare.com/workers/cache/) is a
cache that sits **in front of** the Worker: Cloudflare stores responses whose
caching headers mark them cacheable and answers repeat requests without
invoking the Worker at all. Pracht maps time-revalidated ISG onto it;
webhook-only ISG routes stay on the worker-managed Cache API path so
`POST /__pracht/revalidate` takes effect immediately. Enable both sides:

```typescript
// vite.config.ts
cloudflareAdapter({ cache: true });
// or tune the stale window (seconds; default one year):
cloudflareAdapter({ cache: { staleWhileRevalidate: 86400 } });
```

```jsonc
// wrangler.jsonc
{ "cache": { "enabled": true } }
```

With the option on:

- Time-revalidated ISG pages are **not** emitted as static snapshots at build
  time. The first request after a deploy renders fresh (Workers Caching
  partitions the cache per Worker version, so deploys always start cold).
  Webhook-only ISG routes keep their snapshots and the worker-managed path.
- Cold and stale Workers Caching renders use a sanitized `GET` request with the
  pathname only and a canonical representation header (`Accept: text/html`, or
  `text/markdown` for that cache variant). Cookies, authorization, query
  parameters, and the request body never reach `createContext`, middleware, or
  loaders while producing a shared response.
- Routes with both a time and a webhook policy are edge-cached, and
  `POST /__pracht/revalidate` purges their edge entries after regenerating
  the worker-managed copy.
- The worker stamps ISG document responses with
  `cloudflare-cdn-cache-control: max-age=<revalidate>,
  stale-while-revalidate=<staleWhileRevalidate>` — the edge holds the page
  for the route's `revalidate` window, and after the window visitors get the
  cached page instantly while the Worker re-renders it in the background.
  The edge directives live in `cloudflare-cdn-cache-control` (highest
  precedence; Cloudflare consumes and strips it) rather than `Cache-Control`
  because `must-revalidate`/`s-maxage` in `Cache-Control` would prohibit
  serving stale (RFC 9111 §4.2.4) and disable stale-while-revalidate. The
  browser-facing header is `Cache-Control: public, max-age=0,
  must-revalidate`, matching the Node adapter's ISG behavior.
- Responses carry `Cache-Tag: pracht:isg,pracht:route:<id>` so they can be
  purged. Routes that export `markdown` also carry `Vary: Accept` on both
  their HTML and markdown responses so the representations stay separate;
  routes without that export do not vary on `Accept`, and their cached
  document answers markdown-preferring requests too (see
  [Markdown and the static fast path](#markdown-and-the-static-fast-path)).
- A route/shell `headers()` export that sets `Cache-Control` (or
  `cloudflare-cdn-cache-control`) takes full precedence — pracht adds
  nothing, so individual routes can opt out or tune their own policy.
  Pracht also reuses the shared ISG cache-safety policy before stamping edge
  headers: responses with `Set-Cookie`, `Cache-Control: private` /
  `no-store`, or `Vary: Cookie`, `Vary: Authorization`, or `Vary: *` are
  never stored in the shared edge cache.
- Route-state JSON (client navigations) stays `no-store` and always reaches
  the Worker.
- (See [Default `Cache-Control`](#default-cache-control) — this applies on
  every adapter, not only with Workers Caching enabled.)

#### Trailing slashes

The assets binding's default `html_handling` redirects a prerendered route to
its trailing-slash form: `GET /guide` answers `307 → /guide/` on Cloudflare
where Node and Vercel answer `200`. That makes the canonical URL of every
prerendered route differ between adapters, and the generated `llms.txt` emits
the non-slash form, so an agent following it takes a redirect on Cloudflare
only.

`create-pracht` therefore writes `"html_handling": "drop-trailing-slash"` into
the Cloudflare scaffold's `wrangler.jsonc`. Existing apps should add it:

```jsonc
{
  "assets": {
    "binding": "ASSETS",
    "directory": "dist/client",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": true,
  },
}
```

Use `"none"` instead when you do your own routing.

#### Cache-key cardinality

Workers Caching keys inbound requests by the exact path and query string.
Query parameter order and trailing slashes are significant, so `/pricing`,
`/pricing?ref=a`, and `/pricing?ref=b` populate independent entries with
independent revalidation cycles. This differs from Pracht's Node and
worker-managed Cloudflare ISG caches, which key generated pages by pathname.
It also means arbitrary public query values can create unbounded edge entries
and force cold renders.

Pracht cannot replace the cache key from inside the cached entrypoint: on a
hit, Workers Caching answers before that Worker runs, and custom `cf.cacheKey`
values are only honored for same-account calls from another entrypoint. Before
enabling Workers Caching, keep ISG query shapes bounded and canonical:

- Redirect or reject unsupported query parameters and enforce one trailing-
  slash form in an uncached gateway before it calls the cached entrypoint.
- If query parameters do not affect the page, have that gateway call a cached
  entrypoint with a pathname-only `cf.cacheKey`. This adds a gateway invocation
  but collapses tracking and attacker-chosen values onto one cache entry.
- If query parameters must affect the rendered page, use SSR or opt the route
  out with `Cache-Control: private, no-store`; sanitized ISG renders never pass
  the query string to application code.

Cloudflare compares request-header values named by `Vary` verbatim. Pracht
therefore adds `Vary: Accept` only to routes that declare a Markdown
representation, but those routes can still accumulate variants for semantically
equivalent browser and agent `Accept` strings. For high-traffic
markdown-capable routes,
normalize `Accept` to a small HTML/markdown set in the same uncached-gateway
pattern. Purges by Pracht's cache tags or path prefixes invalidate all variants
of the matching URL together.

Because cache hits skip the Worker entirely, middleware does not run for
cached ISG pages. That matches the previous behavior (static snapshots were
served before the framework, too) — keep per-visitor logic on SSR routes.

Purge cached pages from loaders, API routes, or webhook handlers with
`purgeCache` — this is webhook-based ISG revalidation:

```typescript
// src/api/revalidate.ts
import { purgeCache, routeCacheTag } from "@pracht/adapter-cloudflare/cache";

export async function POST() {
  await purgeCache({ tags: [routeCacheTag("pricing")] });
  // also: purgeCache({ pathPrefixes: ["/blog/"] }) or purgeCache({ purgeEverything: true })
  return Response.json({ revalidated: true });
}
```

Protect purge webhooks with a shared secret so strangers cannot flush the
cache — see `examples/cloudflare/src/api/revalidate.ts` for a version that
checks an `x-revalidate-secret` header against a Worker secret.

Purges are scoped to the Worker that owns the cache — no zone-level purge
touches it, and `purgeCache` cannot touch other Workers.

### Exporting Cloudflare primitives (Workflows, Durable Objects, etc.)

Wrangler requires named exports from the worker entry for Workflows, Durable
Objects, and other class-based Cloudflare primitives. Use the
`workerExportsFrom` option to point the adapter at a dedicated module that
re-exports them:

```typescript
cloudflareAdapter({
  workerExportsFrom: "/src/cloudflare.ts",
});
```

```typescript
// src/cloudflare.ts
export { Counter } from "./workers/counter.ts";
export { MyWorkflow } from "./workers/my-workflow.ts";
```

This generates `export * from "/src/cloudflare.ts"` in the built worker entry,
which is what Wrangler needs to discover and register the classes. Keep the
module focused on Cloudflare primitives so the generated worker entry stays
explicit. Pair this with the corresponding `wrangler.jsonc` bindings:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }],
  },
}
```

### Handling queue, cron, and email events (`workerHandlersFrom`)

Queues consumers, Cron Triggers, and Email Routing deliver events to handlers
on the worker's **default export** (`queue`, `scheduled`, `email`, ...), which
the generated entry normally reserves for pracht's `fetch`. Point
`workerHandlersFrom` at a module whose named exports should ride along:

```typescript
cloudflareAdapter({
  workerHandlersFrom: "/src/worker-handlers.ts",
});
```

```typescript
// src/worker-handlers.ts
export async function queue(batch, env, ctx) {
  for (const message of batch.messages) await processJob(message, env);
}

export async function scheduled(event, env, ctx) {
  await runCronSweep(env, ctx);
}
```

The generated entry becomes
`export default { ...handlers, fetch }` — every named export of the module is
merged in, but `fetch` always stays pracht's handler; export request handling
belongs in API routes or middleware instead.

### Preview authority with custom-domain routes

When `wrangler.jsonc` contains a custom-domain route, `wrangler dev` can print
a localhost preview URL while the `Request` delivered to the Worker uses the
configured domain in `request.url`. The browser still connects to localhost,
but origin-sensitive application code sees the Worker's effective URL.

That distinction is load-bearing for Web Bot Auth: HTTP Message Signatures
cover `@authority`, so a request signed for `localhost:<port>` will not verify
when the Worker sees `app.example.com`. Sign the effective Worker authority,
temporarily disable the custom-domain route for local preview, or build first
and select a separate config that keeps `main: "dist/server/worker.js"` but
omits the production route:

```sh
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

`pracht preview` does not forward Wrangler's `--config` flag. The same
authority distinction applies to absolute redirects and any code that derives
an origin from `request.url`.

### WebSockets

A WebSocket upgrade is request handling, so it belongs in an **API route** —
not in `workerHandlersFrom`. Pracht recognises protocol-switch responses
(`101 Switching Protocols`, or any response carrying a `webSocket` handle) and
returns them to the runtime untouched: no security headers, no cache headers,
no reconstruction. That last part is the whole trick — copying the response
would drop the `webSocket` property, since it is a Cloudflare extension to
`ResponseInit` rather than part of the fetch standard.

The socket itself has to be owned by something that outlives the request, which
on Cloudflare means a **Durable Object**. Export it via
[`workerExportsFrom`](#exporting-cloudflare-primitives-workflows-durable-objects-etc)
and have the API route forward the upgrade to it:

```typescript
// src/api/ws.ts
import type { BaseRouteArgs } from "@pracht/core";
import { isUpgradeRequest } from "@pracht/core/server";

export async function GET({ context, request, url }: BaseRouteArgs) {
  if (!isUpgradeRequest(request)) {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const { CHAT_ROOM } = context.env as { CHAT_ROOM: DurableObjectNamespace };
  const room = url.searchParams.get("room") ?? "lobby";
  // The 101 comes straight back out — pracht passes it through unchanged.
  return CHAT_ROOM.get(CHAT_ROOM.idFromName(room)).fetch(request);
}
```

```typescript
// src/workers/chat-room.ts
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation-aware accept: an idle room is evicted from memory without
    // dropping its sockets.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    for (const peer of this.ctx.getWebSockets()) peer.send(String(message));
  }
}
```

Bind and register the class in `wrangler.jsonc` as with any Durable Object:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "CHAT_ROOM", "class_name": "ChatRoom" }],
  },
  "migrations": [{ "tag": "v1", "new_classes": ["ChatRoom"] }],
}
```

Upgrades work in `pracht dev` the same way they do in production — the
Cloudflare adapter owns the dev server, so requests are served by workerd
rather than by pracht's Node dev handler.

`examples/cloudflare` has the full version of both files.

> **Cross-origin upgrades are blocked by default.** Browsers do not apply CORS
> to WebSocket: without a check, any page on the web could open a socket to
> your app and the user's cookies would ride along (cross-site WebSocket
> hijacking). Pracht therefore applies its `api.requireSameOrigin` check to
> upgrade requests as well as to unsafe methods. Requests with no browser
> provenance headers at all (CLIs, server-to-server) still pass, as with
> mutations.
>
> Two things pracht cannot do for you: **authenticate** the connection (do it
> in API middleware or in the handler before forwarding — the handshake is a
> normal request and carries cookies), and **authorize each message** once the
> socket is open, which is entirely the Durable Object's business.

The 30-second `signal` an API route receives covers the handshake, not the
connection: forwarding to a Durable Object returns immediately, and the socket's
lifetime is then the object's to manage. Do not hold the socket in the API
route itself.

### Using Cloudflare bindings in dev

The adapter handles everything — just declare bindings in `wrangler.jsonc`:

```jsonc
{
  "main": "dist/server/worker.js",
  "kv_namespaces": [{ "binding": "MY_KV", "id": "..." }],
  "d1_databases": [{ "binding": "DB", "database_name": "my-db", "database_id": "..." }],
}
```

The `main` field stays pointed at `dist/server/worker.js` for production
deploys. During dev, the adapter automatically overrides the entry to
pracht's virtual server module via `@cloudflare/vite-plugin` — no extra
files needed.

Bindings are available via `context.env` in loaders, middleware, and API routes:

```typescript
// src/api/items.ts
import type { BaseRouteArgs } from "@pracht/core";

export async function GET({ context }: BaseRouteArgs) {
  const value = await context.env.MY_KV.get("key");
  return Response.json({ value });
}
```

Cloudflare itself permits `import { env } from "cloudflare:workers"` followed
by a top-level binding read. Pracht graph commands cannot provide authoritative
Worker bindings, so API and capability modules must defer `env.MY_KV`, `env.DB`,
and `exports.*` property reads until the API handler, capability `run()`, or
another request-time function executes. Importing `env` is safe; reading a
property during module initialization fails closed with the binding name. This
prevents placeholder values from silently changing inspected security or
transport metadata through Boolean checks, `typeof`, or strict equality.

### Generated entry options

When using `cloudflareAdapter()` in `vite.config.ts`, generated entries can import a context factory:

```typescript
cloudflareAdapter({
  createContextFrom: "/src/server/context.ts",
  workerExportsFrom: "/src/cloudflare.ts",
});
```

The context module must export `createContext(args)`. Cloudflare passes `{ request, env, executionContext }`.

### Entry module

```javascript
// virtual:pracht/server (generated in cloudflare mode)
import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";
import { app } from "./src/routes.ts";

const resolvedApp = resolveApp(app);
const apiRoutes = resolveApiRoutes(Object.keys(apiModules), "/src/api");

export default {
  async fetch(request, env, executionContext) {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    return handlePrachtRequest({
      app: resolvedApp,
      registry,
      request,
      context: { env, executionContext },
      apiRoutes,
    });
  },
};
```

---

## Netlify Adapter

`@pracht/adapter-netlify` emits a fetch-style Netlify Functions v2 handler and
a generated catch-all wrapper under `netlify/functions/`. Set the site's
publish directory to `dist/client` and its functions directory to
`netlify/functions`:

```typescript
import { netlifyAdapter } from "@pracht/adapter-netlify";

pracht({ adapter: netlifyAdapter() });
```

```toml
[build]
  command = "pnpm build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

The generated function claims page URLs, while `/assets/*` and `/_pracht/*`
bypass it. This keeps `Accept: text/markdown` negotiation and route-state
requests inside Pracht without charging a function invocation for hashed
assets. Add application-specific static prefixes with
`netlifyAdapter({ excludedPath: ["/images/*"] })`; do not exclude page URLs.
Default and prefix-shaped exclusions are also omitted from the generated
function bundle, so large static asset trees do not count against Netlify's
function size limit. The generated config enumerates each remaining client file
and writes exclusions relative to the generated function file, so Netlify's
Functions v2 file tracer cannot pull bypassed trees back into the bundle.
An exact exclusion such as `/feed.xml` omits only that exact file; unlike a
prefix exclusion, it does not also exclude `/feed.xml/` or an `index.html`
representation that those URLs can still invoke the function to read.
Bundled static lookup decodes percent-encoded spaces and Unicode characters,
while rejecting encoded separators and traversal segments before filesystem
resolution.

### SSG and ISG

- SSG documents are read from the bundled `dist/client` output and use
  `Netlify-CDN-Cache-Control` with durable caching. Route and shell headers from
  `headers-manifest.json` are applied before the response enters the cache. An
  explicit Netlify-supported cache policy (`Cache-Control`,
  `CDN-Cache-Control`, or `Netlify-CDN-Cache-Control`) remains authoritative
  instead of being combined with Pracht's durable-cache default. Headers that
  target another CDN do not disable Netlify caching.
- ISG renders use a sanitized, pathname-only request and an allowlisted
  Netlify context. Visitor cookies, IP/geolocation, request IDs, and arbitrary
  request-local context are unavailable, while deployment-wide site/server
  metadata and `waitUntil()` remain available. Their Pracht time policy becomes
  the durable CDN `max-age`; stale-while-revalidate is configurable with
  `staleWhileRevalidate`. A cacheable custom policy remains authoritative.
  ISG routes get no build-time snapshot on Netlify — the handler always renders
  them through the durable cache, so a snapshot would only be reachable at its
  literal `/index.html` URL where it would never revalidate. The first request
  after a deploy renders cold. A document request with one trailing slash gets
  a permanent redirect to the slashless manifest path before Pracht renders,
  so only the canonical URL enters the durable cache. Webhook revalidation
  accepts either spelling and purges the canonical cache tag. Because
  sanitization also strips
  `Accept-Language` and masks geolocation, an ISG route whose middleware or
  loader picks a locale from the request will cache its default-locale output
  for every visitor globally — localized ISG pages need the locale in the path
  (`/en/pricing`), the same rule the other adapters' shared ISG caches imply.
- Cached SSG and ISG HTML names its route-state variants through `Netlify-Vary:
  query=_data,header=x-pracht-route-state-request`: both route-state
  transports (the `?_data=1` query param and the request header client
  navigations actually send) get their own cache key instead of receiving the
  cached HTML, while unrelated query parameters collapse onto the pathname
  cache entry. Netlify combines that key with Pracht's standard `Vary: Accept`
  header on Markdown-capable routes; `Accept` is not a valid `Netlify-Vary`
  directive. Route-state and Markdown responses are never durable-cached
  themselves by default. If an application explicitly makes a negotiated SSG
  representation cacheable, it reuses the prerendered HTML's `Netlify-Vary`
  instructions so every response from that URL defines the same cache key. A
  custom `Netlify-Vary` header takes precedence.
- Because `/assets/*` (and other `excludedPath` prefixes) bypass the function,
  the build also writes a `dist/client/_headers` file that gives Netlify's
  static layer the immutable asset policy and the same default security
  headers the function applies everywhere else. A hand-authored
  `public/_headers` wins — pracht then skips generating one and warns.
  Default and prefix-shaped exclusions are also omitted from the function's
  `includedFiles`, keeping large bypassed asset trees outside its bundle. The
  generated config lists each remaining client file explicitly because the
  production Functions v2 tracer follows the server's filesystem access. Its
  matching exclusions are rooted relative to the generated function file so
  traced bypassed trees are removed too.
  `excludedPath` entries are validated against whitespace/control characters so
  they cannot inject rules into that plain-text file.
- Cacheable webhook-capable ISG responses carry per-path
  `Netlify-Cache-Tag` values, including responses with custom cache policies.
  Authenticated `POST /__pracht/revalidate` requests purge those tags through
  `@netlify/functions`.
- SSR and API responses without an explicit policy get Pracht's fail-closed
  `private, no-cache` default. Explicit public policies are also copied to
  Netlify's durable cache header, and the promoted response gets
  `Netlify-Vary: query,header=x-pracht-route-state-request` so the CDN-cached
  document cannot shadow route-state fetches; a standard `Vary: Accept` remains
  responsible for content negotiation, and `query` keeps Netlify's default
  full-query cache key for dynamic routes. Promotion itself fails closed: a
  route-state-shaped request (either transport) or a response that is not
  shareable (`Set-Cookie`, `Vary: Cookie`/`Authorization`) gets
  `Netlify-CDN-Cache-Control: private` instead — a bare `Cache-Control:
  public` would otherwise make Netlify's CDN store one visitor's render (or,
  for a cross-site `?_data=1` navigation, cache the HTML fallback under the
  same key later first-party JSON fetches use). An explicit
  `Netlify-CDN-Cache-Control` or `Netlify-Vary` stays fully user-owned.

Generated entries can import a context factory, and custom handlers can be
created directly:

```typescript
import { createNetlifyHandler } from "@pracht/adapter-netlify";

netlifyAdapter({
  createContextFrom: "/src/server/context.ts",
  functionName: "pracht",
  staleWhileRevalidate: 86_400,
  staticMaxAge: 604_800,
});
```

Both cache windows accept `0`: it disables stale serving for
`staleWhileRevalidate` and gives SSG documents no fresh lifetime for
`staticMaxAge`.

The context factory receives `{ request, context }`, where `context` is
Netlify's Functions v2 context. Build first, then use `netlify dev` for local
platform testing; `pracht preview` does not emulate Netlify's Functions or CDN
cache.

---

## Vercel Adapter (Phase 2)

### `createVercelEdgeHandler(options)`

| Option          | Type                                    | Description                                     |
| --------------- | --------------------------------------- | ----------------------------------------------- |
| `app`           | `PrachtApp`                             | The resolved app                                |
| `registry`      | `ModuleRegistry`                        | Module importers                                |
| `createContext` | `(args: VercelContextArgs) => TContext` | Context with the incoming edge-function context |

### Features

- **Edge runtime handler**: generated server entries export a default `fetch`-style
  handler that Vercel bundles as an Edge Function.
- **Build Output API v3**: `pracht({ adapter: vercelAdapter() })` makes `pracht build`
  emit `.vercel/output/config.json`, `.vercel/output/static/`,
  `.vercel/output/functions/render.func/`, and route-named prerender functions
  for ISG paths.
- **Local preview**: there is no faithful local Vercel production runtime, so
  `pracht preview` does not emulate one — it points at `vercel build` /
  `vercel dev` instead.
- **Clean URL routing**: prerendered SSG pages are copied into
  `.vercel/output/static` and exposed through `config.json` rewrites so `/about`
  resolves to `/about/index.html`.
- **Route-state bypass**: Vercel build output adds rules for both
  `x-pracht-route-state-request: 1` and `?_data=1`, so route-state requests go
  to the edge function before any static SSG rewrite can serve cached HTML.
- **Native ISR**: ISG routes are emitted as Build Output API prerender functions
  with `.prerender-config.json` files. Vercel only supports ISR on Serverless
  Functions — a `.prerender-config.json` next to an Edge Function fails the
  deployment with `Unexpected function type "EdgeFunction"` — so these run on
  Node (`nodejs22.x`) while the main handler stays on the edge. Both load the
  same server bundle: it is built against Web APIs only, which Node provides
  natively. The first ISG route materializes the function directory and the
  rest are symlinks to it, so N ISG paths don't duplicate the bundle. Time
  policies become Vercel
  `expiration` values, build-time HTML becomes the prerender fallback, and
  `PRACHT_REVALIDATE_TOKEN` is used as the `bypassToken` when present at build
  time. If the env var is absent during build, Pracht writes a random bypass
  token and the runtime webhook endpoint still fails closed until the env var is
  configured. When webhook revalidation is used, the token must be set **at
  build time**: the `bypassToken` is baked into the build's
  `*.prerender-config.json`, so setting the env var only at runtime
  authenticates the webhook but cannot bypass Vercel's prerender cache — such
  paths are reported as `failed` (detected via the
  `x-vercel-cache` response header) until you rebuild with
  `PRACHT_REVALIDATE_TOKEN` set.
- **Function-name safety**: the build fails with a descriptive error when an ISG
  route would use the same `.func` directory as the main edge function (for
  example, `/render` with the default `functionName: "render"`). Rename the
  route or set a non-conflicting `functionName` in `vercelAdapter()`.
- **Dynamic fallback**: SSR and API routes are routed to the generated edge
  function. ISG document requests are handled by route-named prerender functions,
  while route-state requests still bypass static/prerender output and reach the
  edge function.
- **Node launcher**: generated entries also export `nodeListener`
  (`createVercelNodeListener(handle)`), which the ISG functions re-export as
  their handler. A custom server entry that omits it fails the build with a
  descriptive error rather than at request time in production. The listener
  supplies a `waitUntil()`-compatible context and drains registered work after
  ending the response; other Edge-only context fields are unavailable on Node
  ISG invocations.
- **Sanitized ISG renders**: Vercel keys the prerender cache on the path alone
  (`allowQuery: []`) and replays the stored response to every later visitor, so
  the launcher renders on the same sanitized ISG request the Node and Cloudflare
  regeneration paths use — `GET`, `Accept: text/html`, path only. The triggering
  visitor's `Cookie`/`Authorization` headers, query string, and body never reach
  loaders, middleware, or `createContext`, so a cache miss cannot materialize a
  personalized page into shared cache. On the way out, credential headers
  (`Set-Cookie`, `Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`,
  secret-shaped `x-*`) are stripped with a logged error — the same set
  build-time prerendering refuses outright — and a response that marks itself
  uncacheable (`Cache-Control: private`/`no-store`, `Vary: Cookie`/
  `Authorization`) is logged as a warning, because Vercel's prerender cache
  stores it regardless. Render such routes as `ssr` instead.
- **Static security headers**: the generated `config.json` includes a `headers`
  section that applies the same baseline security headers to all responses,
  including static assets served by Vercel's CDN. Static prerendered routes also
  get route and shell document headers from the prerender header manifest.
  SSG/ISG prerendering rejects dangerous document headers such as `Set-Cookie`,
  `Authorization`, `Proxy-Authenticate`, `WWW-Authenticate`, and secret-shaped
  custom `x-*` headers before they can enter that manifest.

### Generated entry options

When using `vercelAdapter()` in `vite.config.ts`, generated entries can import a context factory:

```typescript
vercelAdapter({
  createContextFrom: "/src/server/context.ts",
  functionName: "render",
  regions: ["iad1"],
});
```

The context module must export `createContext(args)`. Edge invocations receive
Vercel's execution context; Node ISG invocations receive the compatibility
context described above. `regions: "all"` keeps the Edge function global and
leaves Node ISG functions on the project's default Serverless region because
`all` is not a Node region identifier.

### Entry module

```javascript
// virtual:pracht/server (generated in vercel mode)
import { resolveApp, resolveApiRoutes } from "@pracht/core/server";
import { createVercelEdgeHandler, createVercelNodeListener } from "@pracht/adapter-vercel";
import { app } from "./src/routes.ts";

const resolvedApp = resolveApp(app);
const apiRoutes = resolveApiRoutes(Object.keys(apiModules), "/src/api");

export const vercelFunctionName = "render";

export default async function handle(request, context) {
  const handler = createVercelEdgeHandler({
    app: resolvedApp,
    registry,
    apiRoutes,
    clientEntryUrl: clientEntryUrl ?? undefined,
    cssManifest,
  });
  return handler(request, context);
}

// Entry point of the Node serverless functions emitted for ISG routes.
export const nodeListener = createVercelNodeListener(handle);
```

---

## Static Adapter

`@pracht/adapter-static` produces a **pure static export**: `pracht build`
prerenders every route into `dist/client/`, and that directory deploys to any
static host — GitHub Pages, S3, nginx, Netlify — with zero server. It is the
analogue of SvelteKit's `adapter-static` and Next's `output: "export"`.

```ts
// vite.config.ts
import { staticAdapter } from "@pracht/adapter-static";
pracht({ adapter: staticAdapter() });

// optional SPA fallback document:
pracht({ adapter: staticAdapter({ fallback: "200.html" }) });
```

### Build-time validation (fail closed)

A static export has no runtime server, so `pracht build` fails with an
aggregated error — before any prerendering — when the app needs one:

- **Routes** must be `render: "ssg"` (or `"spa"`, whose shell HTML is
  prerendered). `ssr` and `isg` routes are hard errors naming each route and
  pointing at the serverful adapters.
- **API routes** are hard errors (nothing can answer them).
- **Capabilities exposed over HTTP/MCP/WebMCP** are hard errors. Unexposed
  capabilities are fine — `invokeCapability()` from build-time loaders runs
  during prerender.
- **Routes under `/_pracht/`** are hard errors: that namespace is reserved for
  build metadata and the route-state tree below.
- Webhook/time revalidation is N/A by construction (no ISG routes exist).

### Client-side navigation without a server

On every other adapter, client navigation fetches route-state JSON from the
page URL with the `x-pracht-route-state-request` header — impossible on a
static host. The static adapter solves this at build time:

- For each prerendered route whose navigation performs a state fetch (a loader
  or route middleware), the build renders the route-state request **a second
  time** — the same rendering the live endpoint performs — and writes the JSON
  body to `dist/client/_pracht/state/<path>/index.json` (`/` →
  `_pracht/state/index.json`). The `index.json` leaf keeps `/blog` and
  `/blog/hello` from contending for one path, and `_pracht/` is already
  reserved, so state files can never collide with a prerendered route or a
  `public/` file.
- **Loaders (and route middleware) therefore run twice per page** during a
  static build: once for the HTML document, once for the state file. Like
  `getStaticPaths()`, they must be deterministic and side-effect free at build
  time — a loader that reads `Date.now()`, randomness, or mutable external
  state produces an HTML document and a state file with *different* data, so
  the hydrated page and the first client navigation back to it disagree.
- The client bundle is compiled with the `__PRACHT_STATIC_TARGET__` define
  (driven by the adapter's `staticTarget: true` flag), which switches
  `fetchPrachtRouteState()` — navigation, prefetch, SPA boot, revalidation —
  to those files. Every other adapter compiles the flag to `false` and
  dead-code-eliminates the static branch; dev servers always use the live
  endpoint.
- Loaderless routes fetch nothing; islands/`none`-hydration routes keep their
  MPA full-document navigation and get no state files.
- Query strings are dropped when resolving the state URL: build-time loader
  data has no query variants, matching what the build generated.

State files are plain JSON served as `application/json` and parsed with
`response.json()` — the same escaping posture as the live route-state
endpoint. Loader data containing HTML stays inert data. A state fetch that
misses (a stale navigation after a redeploy that removed a route, a host that
answers the miss with an HTML error document) rejects; for `ssg` routes the
router then falls back to a full-document navigation, which the host answers
with the real page or its 404 document. For `render: "spa"` routes — whose
dynamic, non-enumerated paths have no state file by construction — the router
renders the route client-side **without loader data** instead of reloading:
a document load could only land on the host's 404 page or bounce through the
SPA fallback document.

**Revalidation is a no-op with fresh-looking plumbing**: `useRevalidate()`
(and the automatic refresh after a settled capability call) refetches the
static state file with `cache: "reload"` — it always returns the build-time
payload again. Data on a static export only changes by redeploying. Put
truly live data behind a client-side fetch to an external API instead.

### 404 and the SPA fallback

- `404.html` — the app's `defineApp({ notFound })` page, rendered at build
  time (the GitHub Pages / S3 error-document convention). The hydrated page
  adopts `window.location`, so it displays and navigates from the URL actually
  visited, not the synthetic build-time path. Apps without a `notFound` page
  emit no `404.html` (the host serves its own error page).
- `200.html` — opt-in via `staticAdapter({ fallback: "200.html" })`: an
  empty-shell document that boots the client router and resolves the real
  route from `window.location`. Configure the host to rewrite unmatched URLs
  to it (Netlify `/* /200.html 200`, nginx `try_files`, S3/CloudFront error
  document with code 200). This is **required** for deep links into dynamic
  `render: "spa"` routes, which have no prerendered file; without a rewrite
  those URLs land on `404.html`. (In-app client navigation to dynamic SPA
  routes works without the fallback — the router renders them client-side,
  without loader data. The rewrite only governs full-document loads: deep
  links, reloads, opening in a new tab.) During a fallback boot, a missing
  state file renders the route without loader data instead of reloading (a
  reload would re-serve the fallback document and loop). GitHub Pages cannot
  rewrite — deep links to and reloads of dynamic SPA paths land on the 404
  page there.
- A host that serves `404.html` with status **200** (S3 without an error-
  document configuration, some CDN defaults) changes nothing for the client —
  hydration adopts `window.location` either way — but crawlers will index
  unknown URLs as real pages. Configure the host's error document so the
  status stays 404.

### Host configuration

- **Clean URLs**: pages are emitted as `<path>/index.html`. The host must
  serve `index.html` for directory URLs; most hosts redirect `/about` →
  `/about/` first (GitHub Pages answers `301`), which the client router and
  prerendered links tolerate.
- **Headers**: no server means no dynamic headers. `dist/client/_pracht/headers.json`
  records the document headers each prerendered route would have carried
  (route/shell `headers()` exports plus pracht's defaults) — mirror the ones
  you care about in the host's header configuration (`_headers` on Netlify,
  CloudFront response header policies, nginx `add_header`).
- **Markdown negotiation**: routes exporting `markdown` rely on server-side
  `Accept` negotiation; a static host always answers with the HTML file. The
  build prints a note when this applies — publish `.md` files under `public/`
  when a raw-markdown corpus matters.
- **Percent-encoded dynamic params**: prerender output directories keep the
  percent-encoded form (`/posts/caf%C3%A9` → a directory literally named
  `caf%C3%A9`). Hosts that decode URLs before filesystem lookup (most do)
  will miss those files — prefer ASCII-safe param values for static exports.
- **Base paths** (deploying under a sub-path such as GitHub Pages project
  sites) are not yet wired through: prerendered asset and state URLs are
  root-relative. Deploy static exports at an origin root for now.

### `pracht preview`

`pracht build` still writes `dist/server/server.js`, but only as build/preview
tooling — nothing in it is deployed. Running it (or `pracht preview`) serves
`dist/client/` with a tiny static file server (`createStaticPreviewHandler`)
that mirrors a plain host: files, clean URLs, `404.html` for misses, and the
configured `200.html` rewrite. It reuses `@pracht/adapter-node`'s hardened
static file resolution (NUL/backslash/symlink/traversal guards).

---

## Default `Cache-Control`

Every adapter stamps `Cache-Control: private, no-cache` on `GET`/`HEAD`
responses that carry no caching policy of their own.

A shared cache in front of the app — Cloudflare's Workers Caching, a CDN, an
nginx reverse proxy — may apply RFC 9111 heuristic freshness to a `200` with no
`Cache-Control`, and `Cookie` is not part of its cache key. Without the default,
an authenticated SSR page or an API `GET` can be stored and replayed to a
different user. That hazard belongs to "shared cache in front of an origin", not
to any one platform, so Node, Cloudflare, Netlify, and Vercel apply the identical default
through one shared implementation: an app hardened on one adapter keeps the
protection when it moves to another.

Untouched: anything that already declares a policy — route-state JSON, static
assets, and your own `headers()` exports or middleware — including a
CDN-targeted one (`CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`,
`Netlify-CDN-Cache-Control`, `Vercel-CDN-Cache-Control`, `Surrogate-Control`). Also untouched:
non-`GET`/`HEAD` responses, protocol-switch (`101`) responses, and ISG
documents.

ISG is exempt deliberately. Those responses are stored and replayed by the
platform — Vercel's prerender cache, the Node on-disk snapshot, Cloudflare's
Cache API, or Netlify's durable cache — so stamping `private, no-cache` would
both defeat that cache and
make a route's headers depend on whether its snapshot exists yet. ISG responses
carry `public, max-age=0, must-revalidate` instead.

To opt a route out, set your own policy:

```typescript
export function headers() {
  return { "cache-control": "public, max-age=300" };
}
```

---

## Markdown and the static fast path

Routes that export `markdown`, or declare `markdown: true` when middleware owns
negotiation, can answer `Accept: text/markdown` instead of HTML (see
[DATA_LOADING.md](DATA_LOADING.md)). Prerendered
documents are served by the adapter before the framework runs, so the Node,
Cloudflare, and Netlify adapters have to decide up front whether a cached
document can answer a given request. All three require **two** conditions before
skipping the static file (Node and Netlify), the assets binding, or the edge
cache (Cloudflare):

1. the request prefers markdown over HTML — the same `prefersMarkdown()`
   negotiation the runtime uses, so `*/*`, `text/html,*/*`, and a q-weighted
   `text/html,text/markdown;q=0.1` all keep getting HTML; and
2. the route appears in `markdown-manifest.json`, which the build derives from
   the route module's actual `markdown` export or explicit `markdown: true`
   route metadata rather than user-defined response headers.

An app with no markdown routes therefore never leaves its static fast path,
whoever is asking: agent traffic cannot force SSR renders of prerendered pages,
and hashed assets are never re-rendered because a client sent an odd `Accept`.
The build emits an empty manifest for SSR-only apps too, so public files keep
the same guarantee even when the app has no prerendered documents.

A `.md` file in `public/` is a different thing entirely: it is a plain static
asset, copied to `dist/client/` by the build and served by content type, not by
negotiation. Those files answer every request the same way: the Node and
Netlify adapters send `Content-Type: text/markdown; charset=utf-8`, and on
Cloudflare and Vercel
the platform's own asset layer types the file (the `ASSETS` binding and the
static rewrite respectively, neither of which the adapter intercepts). This is
the route to take for a corpus that is markdown all the way down (a skills
catalog, a docs mirror); no middleware is needed to correct the header.

Vercel reaches the same outcome through its routing table rather than adapter
code, because the platform serves prerendered files before any function runs.
The build emits an `Accept`-conditional route to the render function, ahead of
the static rewrite, for each prerendered route in the markdown manifest — and
only those. The header match there is coarser than `prefersMarkdown()` by
necessity (Vercel's `has` takes a regex, not a q-value parser), so anything
mentioning `text/markdown` reaches the function, which then applies the real
negotiation and still answers HTML when HTML is preferred. The trade is that on
those routes a client can force a function invocation with the header alone,
even at `q=0` — so the entry is emitted only for routes that declare a Markdown
representation. Every other prerendered page keeps its static fast path
whatever the client sends. ISG routes with a Markdown representation route to
the render function rather than their prerender function, which re-renders on
a sanitized `Accept: text/html` and can only produce HTML.

---

## ISG Webhook Revalidation

Routes opt into webhook revalidation with `webhookRevalidate()` or by combining
it with `timeRevalidate()`:

```typescript
import { timeRevalidate, webhookRevalidate } from "@pracht/core";

route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: [timeRevalidate(3600), webhookRevalidate()],
});
```

All built-in adapters expose the same endpoint:

```sh
curl -X POST https://example.com/__pracht/revalidate \
  -H "Authorization: Bearer $PRACHT_REVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["/pricing"]}'
```

The body must include `paths` as an array of at most 64 concrete URL paths;
larger batches are rejected with `400`. The endpoint returns JSON with
`revalidated`, `skipped`, and `failed` path arrays plus a `details` array
carrying the per-path reason:

```json
{
  "revalidated": ["/pricing"],
  "skipped": ["/blog", "/typo"],
  "failed": [],
  "details": [
    { "path": "/pricing", "outcome": "revalidated" },
    { "path": "/blog", "outcome": "skipped", "reason": "no_webhook_policy" },
    { "path": "/typo", "outcome": "skipped", "reason": "not_a_route" }
  ]
}
```

Skip reasons are `not_a_route`, `not_isg`, `not_prerendered`, and
`no_webhook_policy` — the last is the common one: a route with only a
`timeRevalidate()` policy is not refreshable by webhook. A path lands in
`failed` when regeneration did not produce cacheable 200 HTML (loader error,
malformed manifest metadata, `Set-Cookie`, `Cache-Control: private`/`no-store`,
cache write failure); the previously generated copy stays live, and the batch
continues instead of aborting with a 500.

The three path arrays are the stable contract and are unchanged; `details` is
additive.

Set `PRACHT_REVALIDATE_TOKEN` in the deployment environment. Auth uses a
constant-time comparison and fails closed with `401` when the token is missing
or incorrect. Webhook providers that cannot send bearer auth can send the same
secret in `x-pracht-revalidate-token`.

Regeneration never replays the webhook request's cookies, authorization
headers, locale, or other user-specific headers. Adapters synthesize a clean
`GET` document request for the target path.

Concurrent regenerations of the same path are single-flighted: a stampede of
stale requests (or repeated webhook posts) share one in-flight render per
process/isolate instead of racing N parallel regenerations.

Single-flight callers join the render that is already running. A webhook that
arrives during a stale-request regeneration can therefore report the path as
`revalidated` even when that render started before the content change that
triggered the webhook. Send a later webhook when strict post-change freshness
is required.

Dynamic ISG paths that `getStaticPaths()` did not enumerate at build time are
not in the prerender manifest. Regular requests for such paths still work —
they fall through to the server render on every request, without a cached
copy. Webhook posts naming them are reported as `skipped` on Node and
Cloudflare (nothing cached to refresh). Vercel matches route patterns rather
than the manifest, so such paths are accepted, but only build-time enumerated
paths have prerender functions — new concrete paths are served per-request by
the edge function.

---

## Writing a Custom Adapter

A custom adapter exports a factory function that returns a `PrachtAdapter` object:

```typescript
import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  myPlatformGraphStubs,
  myPlatformVitePlugin,
} from "my-platform-vite-plugin";

export function myAdapter(options?: MyOptions): PrachtAdapter {
  return {
    id: "my-platform",
    serverImports:
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      // Return JavaScript source code that will be appended to the
      // generated virtual:pracht/server module.
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
    // Optional: contribute extra Vite plugins (e.g. a platform-specific runtime).
    // This hook is synchronous so pracht can return its complete Vite plugin
    // array synchronously from vite.config.ts.
    vitePlugins() {
      return myPlatformVitePlugin({ entry: "virtual:pracht/server" });
    },
    // Optional: contribute only plugins that are safe in read-only graph
    // servers. Do not start a runtime, listener, worker, or debugger here.
    graphVitePlugins() {
      return myPlatformGraphStubs();
    },
    // Optional: set to true when the adapter's Vite plugin runs the dev server
    // itself (pracht will skip installing its own SSR middleware).
    ownsDevServer: true,
    // Optional: set to true when targeting an edge runtime that cannot resolve
    // dependencies from node_modules at runtime. Forces Vite to bundle all
    // dependencies into the SSR output (ssr.noExternal = true).
    edge: true,
    // Optional: set to true when the adapter produces a pure static export
    // with no runtime server. Production builds then compile the client with
    // __PRACHT_STATIC_TARGET__ = true, switching route-state fetching to the
    // serialized /_pracht/state/… files (see the Static Adapter section).
    staticTarget: true,
  };
}
```

The generated server entry module has access to `resolvedApp`, `registry`,
`apiRoutes`, `clientEntryUrl`, `cssManifest`, and `jsManifest` -- your
`createServerEntryModule()` code can reference these directly.

`pracht inspect`, `plan`, `verify`, `report`, `doctor`, and `typegen` create a
short-lived graph-only Vite server. In that mode pracht never calls
`vitePlugins()`; it calls `graphVitePlugins()` when supplied and otherwise
loads no adapter plugins. Keep the graph hook synchronous and metadata-only.
It is intended for safe resolvers or platform-module stubs needed to load app
contracts, not the platform's development runtime.

The entry may import modules that only resolve inside the target runtime (the
Cloudflare adapter re-exports Durable Objects that import `cloudflare:workers`).
Graph-reading tooling -- the `pracht dev` banner, `pracht inspect`, `pracht plan`,
`pracht verify`, and dev-time CSS discovery -- therefore never evaluates
`virtual:pracht/server`. It reads `virtual:pracht/dev-metadata`, an
adapter-neutral module exporting `resolvedApp`, `apiRoutes`, `registry`, and
`buildTarget`, so an adapter is free to emit runtime-only imports.

At the runtime level, an adapter also typically needs to:

1. **Accept a platform request** and convert it to a Web `Request` object
2. **Check for static assets** -- serve files from `dist/client/` with appropriate
   headers (content-type, cache-control with immutable for hashed assets). Skip
   asset serving only for requests that `prefersMarkdown()` accepts *and* whose
   route appears in the generated markdown manifest, so routes that export a
   `markdown` source can respond from the framework — see below. If optional
   manifest metadata is unavailable in a custom or legacy entry, fall through
   for markdown-preferring requests to preserve content negotiation.
3. **Check for prerendered pages** -- SSG and ISG routes have HTML files on disk.
   For ISG, implement staleness checking.
4. **Delegate dynamic requests** to `handlePrachtRequest()` from `pracht`.
   This ordering is what lets `defineApp({ notFound })` stay safe: the
   not-found page only renders once matching *and* asset serving have missed,
   so it can never shadow a real file. If the platform is configured to answer
   misses itself (e.g. Cloudflare's `assets.not_found_handling`), that answer
   wins and the app's not-found page never runs.
5. **Convert the Web `Response`** back to the platform's response format
6. **Provide a context factory** -- create app-level context from platform-specific
   inputs (env bindings, headers, etc.)

### Context factory pattern

The context factory lets adapters inject platform-specific values into loaders,
middleware, and API routes:

```typescript
// Node: inject database pool
createContext: ({ request }) => ({
  db: pool,
  ip: request.headers.get("x-forwarded-for"),
});

// Cloudflare: inject env bindings
createContext: ({ request, env, executionContext }) => ({
  db: env.DB, // D1 binding
  kv: env.CACHE, // KV binding
  waitUntil: executionContext.waitUntil.bind(executionContext),
});
```

This context is available in every loader, middleware, and API route as `args.context`.
