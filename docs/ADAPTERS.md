# Deployment Adapters

Adapters bridge pracht's platform-agnostic core to specific deployment targets.
Each adapter is a thin layer that translates between the platform's request
handling and pracht's Web Request/Response interface.

---

## Architecture

```
Platform Request (e.g. Node IncomingMessage, CF Worker fetch)
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
`dist/server/headers-manifest.json`. SSG/ISG prerendering rejects dangerous
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

### Generated entry options

When using `nodeAdapter()` in `vite.config.ts`, generated entries can import a context factory and tune body limits:

```typescript
nodeAdapter({
  createContextFrom: "/src/server/context.ts",
  maxBodySize: 10 * 1024 * 1024,
});
```

The context module must export `createContext(args)`. Node passes `{ request, req, res }`.

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
  instructions otherwise.
- **KV/D1/R2 support**: custom context factories and the default build entry both
  surface the Cloudflare `env` object.
- **`@cloudflare/vite-plugin` integration**: the adapter automatically includes
  `@cloudflare/vite-plugin`, running the dev server inside workerd so that API
  routes and loaders have full access to Cloudflare bindings (KV, D1, R2,
  Queues, etc.) during development.

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
  routes without that export do not vary on `Accept`.
- A route/shell `headers()` export that sets `Cache-Control` (or
  `cloudflare-cdn-cache-control`) takes full precedence — pracht adds
  nothing, so individual routes can opt out or tune their own policy.
  Pracht also reuses the shared ISG cache-safety policy before stamping edge
  headers: responses with `Set-Cookie`, `Cache-Control: private` /
  `no-store`, or `Vary: Cookie`, `Vary: Authorization`, or `Vary: *` are
  never stored in the shared edge cache.
- Route-state JSON (client navigations) stays `no-store` and always reaches
  the Worker.
- Everything pracht did **not** deliberately mark cacheable gets
  `Cache-Control: private, no-cache` (unless the response already sets its
  own `Cache-Control`). With Workers Caching enabled, Cloudflare would
  otherwise apply heuristic freshness (~2 hours for 200s) to responses that
  carry no `Cache-Control` header — and `Cookie` is not part of the cache
  key, so SSR pages (including authenticated ones) and API GET responses
  would be edge-cached across users.

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
- If a route genuinely renders different content for an unbounded query space,
  opt it out with a route `Cache-Control: private, no-store` header or do not
  enable Workers Caching for that deployment.

Cloudflare compares request-header values named by `Vary` verbatim. Pracht
therefore adds `Vary: Accept` only to routes that actually export `markdown`,
but those routes can still accumulate variants for semantically equivalent
browser and agent `Accept` strings. For high-traffic markdown-capable routes,
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
Objects, Queues, and other Cloudflare primitives. Use the
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
  with `.prerender-config.json` files. Time policies become Vercel
  `expiration` values, build-time HTML becomes the prerender fallback, and
  `PRACHT_REVALIDATE_TOKEN` is used as the `bypassToken` when present at build
  time. If the env var is absent during build, Pracht writes a random bypass
  token and the runtime webhook endpoint still fails closed until the env var is
  configured. The token must be set **at build time**: the `bypassToken` is
  baked into the build's `*.prerender-config.json`, so setting the env var only
  at runtime authenticates the webhook but cannot bypass Vercel's prerender
  cache — such paths are reported as `failed` (detected via the
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

The context module must export `createContext(args)`. Vercel passes `{ request, context }`.

### Entry module

```javascript
// virtual:pracht/server (generated in vercel mode)
import { resolveApp, resolveApiRoutes } from "@pracht/core/server";
import { createVercelEdgeHandler } from "@pracht/adapter-vercel";
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
```

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
`revalidated`, `skipped`, and `failed` path arrays. A path is skipped when it is
not an ISG route, is not in the prerender manifest, or does not opt into
`webhookRevalidate()`. A path lands in `failed` when regeneration did not
produce cacheable 200 HTML (loader error, malformed manifest metadata,
`Set-Cookie`, `Cache-Control: private`/`no-store`, cache write failure); the
previously generated copy stays live, and the batch continues instead of
aborting with a 500.

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
import { myPlatformVitePlugin } from "my-platform-vite-plugin";

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
    // Optional: set to true when the adapter's Vite plugin runs the dev server
    // itself (pracht will skip installing its own SSR middleware).
    ownsDevServer: true,
    // Optional: set to true when targeting an edge runtime that cannot resolve
    // dependencies from node_modules at runtime. Forces Vite to bundle all
    // dependencies into the SSR output (ssr.noExternal = true).
    edge: true,
  };
}
```

The generated server entry module has access to `resolvedApp`, `registry`,
`apiRoutes`, `clientEntryUrl`, `cssManifest`, and `jsManifest` -- your
`createServerEntryModule()` code can reference these directly.

At the runtime level, an adapter also typically needs to:

1. **Accept a platform request** and convert it to a Web `Request` object
2. **Check for static assets** -- serve files from `dist/client/` with appropriate
   headers (content-type, cache-control with immutable for hashed assets). Skip
   asset serving when the request has `Accept: text/markdown` so routes that
   export a `markdown` source can respond from the framework.
3. **Check for prerendered pages** -- SSG and ISG routes have HTML files on disk.
   For ISG, implement staleness checking.
4. **Delegate dynamic requests** to `handlePrachtRequest()` from `pracht`
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
