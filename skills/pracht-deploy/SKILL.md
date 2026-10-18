---
name: pracht-deploy
version: 1.3.0
description: |
  Configure a pracht adapter and deploy to Node, Cloudflare Workers, Netlify,
  Vercel, or a pure static host: platform config, build, Docker, production
  checklist.
  Use for "deploy", "set up deployment", "configure adapter", "deploy to
  cloudflare/netlify/vercel", "static export", "production build".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Deploy

Read `vite.config.ts` and `package.json` before giving any advice — never
assume the current adapter — and ask the user for the target if their message
does not name one. Then read only that adapter's section below. Install the
adapter if it is missing (`pnpm add @pracht/adapter-*`), run `pracht build` to
confirm the build succeeds, smoke-test the production runtime, and never push
to production without explicit confirmation.

MCP: when the pracht MCP server is registered (`pracht dev-mcp`), prefer
`inspect_build`/`doctor`/`verify` over shelling out. `inspect_build` (like
`pracht inspect build`) needs a prior `pracht build`; `pracht inspect` needs
the pracht plugin in the vite config.

| Target             | Adapter package              | Local smoke test                       |
| ------------------ | ---------------------------- | -------------------------------------- |
| Node.js            | `@pracht/adapter-node`       | `pracht preview`                       |
| Cloudflare Workers | `@pracht/adapter-cloudflare` | `pracht preview` (delegates to `wrangler dev`) |
| Netlify            | `@pracht/adapter-netlify`    | `pracht build && netlify dev`          |
| Vercel             | `@pracht/adapter-vercel`     | `vercel build` / `vercel dev`          |
| Static export      | `@pracht/adapter-static`     | `pracht preview`                       |

Every adapter is wired the same way — `pracht({ adapter: <name>Adapter(…) })`
in the `plugins` array of `vite.config.ts` — and every target builds with
`pracht build`, which emits `dist/client/` (assets + prerendered HTML),
`dist/server/` (server entry and build tooling),
`dist/server/isg-manifest.json` when ISG routes exist, and
`dist/client/.vite/manifest.json`.

---

## Node.js

```ts
pracht({ adapter: nodeAdapter({ canonicalOrigin: "https://app.example.com" }) });
```

Run with `node dist/server/server.js` (port 3000 by default). For production,
put it behind a reverse proxy (nginx, Caddy) and a process manager (PM2,
systemd) with `NODE_ENV=production`. `pracht preview` builds and runs it in one
step (`--port <n>`, `--skip-build` to reuse a build).

- Pin `canonicalOrigin` in production so `request.url` does not depend on the
  incoming `Host` header. `maxBodySize` is also available on `nodeAdapter()`.
- `createNodeRequestHandler({ trustProxy: true })` is only for custom entries
  behind a trusted proxy that overwrites forwarded headers.
- If that proxy strips Vite's deploy base from the forwarded path, set
  `nodeAdapter({ basePathStripped: true })` (same option on a custom
  `createNodeRequestHandler`). Do not infer this from the first path segment —
  a route may legitimately begin with the same segment as the deploy base. The
  adapter restores the public base before `createContext()`, loaders, and API
  handlers see the request, and the proxy must then own the public bare-base
  redirect (`/app` → `/app/`), since the stripped origin cannot tell it from a
  legitimate base-free `/app` route.
- Responses are compressed by default (brotli/gzip negotiated via
  `Accept-Encoding`, streaming for dynamic bodies, an in-memory LRU for static
  assets). Behind a proxy or CDN that already compresses, set
  `nodeAdapter({ compression: false })` to avoid doing it twice.
- The generated server drains on `SIGTERM`/`SIGINT`: it stops accepting
  connections and waits for in-flight requests and `args.waitUntil()` work up
  to `nodeAdapter({ shutdownTimeoutMs })` (default 10s). Keep it below the
  process manager's kill grace period. A custom `createNodeRequestHandler()`
  server calls `await handler.drain(ms)` after `server.close()` instead.
- Background work after the response is `args.waitUntil(promise)` on every
  adapter — do not wire `executionContext.waitUntil` (Cloudflare) or the
  platform context yourself.

Docker:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY dist/ dist/
COPY package.json .
EXPOSE 3000
CMD ["node", "dist/server/server.js"]
```

---

## Cloudflare Workers

```ts
pracht({ adapter: cloudflareAdapter() });
```

```bash
pracht build && npx wrangler deploy
```

```jsonc
// wrangler.jsonc — canonical version at examples/cloudflare/wrangler.jsonc
{
  "name": "my-pracht-app",
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    // "force-trailing-slash" with pracht({ trailingSlash: "always" })
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"],
  },
}
```

`pracht build` generates `dist/server/wrangler.json` from this file — adding
`main: "worker.js"`, `no_bundle: true`, the `ESModule` rule, and the assets
directory — and `wrangler deploy` / `wrangler dev` use it through the
`.wrangler/deploy/config.json` redirect. Do not add those keys by hand; older
configs that still set `main: "dist/server/worker.js"` keep working.
`"binding": "ASSETS"` and `run_worker_first` are required. Without the
binding, `env.ASSETS` silently resolves to `null`: headers and ISG manifests
load empty, so SSG serving, ISG revalidation, and per-route headers all no-op.
If you rename the binding via `cloudflareAdapter({ assetsBinding: "STATIC" })`,
the wrangler `binding` value must match. Without `run_worker_first`, prerendered
pages skip the Worker, so ISG, Markdown negotiation, and route headers stop.
The `"!/assets/*"` pattern keeps content-hashed files off the Worker;
`pracht build` writes `dist/client/_headers` so they still get
`Cache-Control: public, max-age=31536000, immutable` and the security headers
(an app-owned `public/_headers` replaces it; the build warns what it must
cover). `"run_worker_first": true` also works but invokes the Worker per asset.

**Named environments.** Select one at build time:
`CLOUDFLARE_ENV=staging pracht build && npx wrangler deploy`. A build without
`CLOUDFLARE_ENV` writes no redirect when the config defines environments, so
`wrangler deploy --env staging` reads `wrangler.jsonc` itself — which then needs
`main: "dist/server/worker.js"`, `no_bundle: true`, the `ESModule` rule for
`"**/*.js"`, and `assets.directory: "dist/client"`.

**Typed bindings.** `npx wrangler types` writes `worker-configuration.d.ts`
(an `Env` interface for the wrangler bindings plus the Workers runtime types).
Register `context: { env: Env; executionContext: ExecutionContext }` on
`Register` in `src/env.d.ts` and include the file in every tsconfig that checks
route modules (`tsconfig.client.json` in a scaffolded app). `create-pracht`
wires a `cf-typegen` script and regenerates before `typecheck`; rerun it after
changing bindings. Without the file `context.env` is `any`.

**Local preview.** `pracht preview` builds, then delegates to `wrangler dev`
against the generated config. Wrangler owns the binding environment: put
local-only secrets like `PRACHT_CONFIRMATION_SECRET` and
`PRACHT_REVALIDATE_TOKEN` in a gitignored `.dev.vars` (prefixing the host
command with them does not expose them inside the Worker) and keep production
values in `wrangler secret`. With a custom-domain route in the config, preview
listens on localhost while `request.url` inside the Worker uses the custom
domain — sign that effective `@authority` for Web Bot Auth, or temporarily
remove the route. `pracht preview` does not forward Wrangler's `--config`, so a
separate local config means `pracht build && npx wrangler dev --config
wrangler.local.jsonc --port 3000`. `--config` bypasses the generated config, so
that file needs `main: "dist/server/worker.js"`, `no_bundle: true`, the
`ESModule` rule, and `assets.directory: "dist/client"` while omitting the
production route.

**Bindings.** Read them inside a loader, API handler, capability `run()`, or
another request-time function — `context.env.MY_KV.get("key")`. Workers permits
top-level `env` reads, but graph inspection deliberately fails them rather than
report binding metadata it cannot authoritatively resolve.

**Worker module.** When the app needs Durable Objects, Workflows, Cron
Triggers, Queue consumers, Email Routing, or code around each request, give it
its own Worker module with `cloudflareAdapter({ workerEntry: "/src/worker.ts" })`.
Its default export is the deployed Worker (`fetch` plus `scheduled`, `queue`,
`email`), its named class exports are deployed beside it, and
`createPrachtHandler()` serves pracht from `fetch`. Pass `createContext` there;
`workerEntry` cannot be combined with `workerExportsFrom`, `workerHandlersFrom`,
or `createContextFrom`.

```ts
// src/worker.ts
import { createPrachtHandler } from "@pracht/adapter-cloudflare/worker";

export { Counter } from "./workers/counter.ts";

const pracht = createPrachtHandler();

export default {
  fetch(request, env, ctx) {
    return pracht.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await runCronSweep(env, ctx);
  },
};
```

To change headers on pracht's response, copy it first
(`new Response(response.body, response)`): an API route that returns a
subrequest or Durable Object response passes along its immutable headers.

**ISG.** Works with no cache option: the worker-managed path serves the
build-time snapshot, detects staleness, regenerates in the background per colo
via the Workers Cache API, and `POST /__pracht/revalidate` forces regeneration
in the colo that receives it (`"scope": "colo"`).
`cloudflareAdapter({ cache: true })` plus `{ "cache": { "enabled": true } }` in
wrangler.jsonc moves that to edge-tier Workers Caching: time-revalidated pages
then render on demand, are cached for their `revalidate` window (stale served
instantly while the Worker re-renders), and can be purged early with
`purgeCache()` from `@pracht/adapter-cloudflare/cache`. Webhook-only ISG routes
keep their build-time snapshots and the worker-managed path either way.

Audit ISG URLs for unbounded query strings before enabling it — Workers Caching
keys the exact path and query string, including parameter order and trailing
slashes. Use a bounded query allowlist or canonical redirect, or an uncached
gateway with a pathname-only `cf.cacheKey`, and normalize `Accept` there for
routes that export markdown or declare `markdown: true`. See
<https://pracht.resynapse.dev/docs/adapters#isg-and-workers-caching>.

**Void.** To deploy with `void deploy`, put `voidPlugin()` from `void` before
`pracht()` and use `cloudflareAdapter({ configPath: "./.void-wrangler.jsonc" })`.
Bindings and `compatibility_flags` (including `nodejs_als`) move from
`wrangler.jsonc` to `void.config.ts`; delete `wrangler.jsonc`. Loaders that call
`void/*` helpers must be on `render: "ssr"` routes — prerendering has no
bindings.

---

## Netlify

```ts
pracht({ adapter: netlifyAdapter() });
```

```toml
# netlify.toml
[build]
  command = "pnpm build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

```bash
npx pracht build && npx netlify dev
npx netlify deploy --build --prod
```

`pracht preview` exits with guidance here — it cannot emulate Netlify's
Functions and CDN. Build the generated function first, then use `netlify dev`.
Set `PRACHT_REVALIDATE_TOKEN` in Netlify when webhook revalidation is enabled.

The build emits `netlify/functions/pracht.mjs`. Page requests go through it so
Markdown negotiation and route-state requests stay correct; hashed assets
bypass it and stay outside the function bundle at the origin root. With a Vite
deploy base, the function instead bundles and serves the base-free asset and
`/_pracht` trees so `/app/...` requests stay inside the mount; custom
`excludedPath` entries still bypass their literal origin-root URLs, but their
files remain bundled for base-prefixed requests. The generated config
enumerates only client files the function can serve and roots exclusions at the
function file, so Netlify's tracer cannot re-add bypassed trees.
When MCP OAuth is enabled, an exclusion matching either the protected MCP
resource path or its reserved metadata paths is a build error because it would
bypass the framework's authentication handler.

Caching: Netlify durable caching implements time-based ISG and per-path cache
tags implement authenticated webhook revalidation. An ISG document request in
the non-canonical spelling permanently redirects to the canonical URL
(slashless unless `trailingSlash: "always"`) before rendering, and webhook revalidation normalizes either spelling before purging
the tag. Only `Cache-Control`, `CDN-Cache-Control`, and
`Netlify-CDN-Cache-Control` override the adapter's cache defaults —
provider-specific headers for another CDN do not; a window of `0` disables
stale serving or freshness. `Netlify-Vary` owns route-state variants while
standard `Vary: Accept` owns Markdown negotiation, and cacheable negotiated SSG
representations reuse their prerendered HTML's `Netlify-Vary` instructions.
Shared ISG renders strip visitor-specific request data and Netlify context
metadata before loaders or context factories run.

---

## Vercel

```ts
pracht({ adapter: vercelAdapter() });
```

```bash
pracht build && npx vercel deploy --prebuilt
```

Emits `.vercel/output/config.json`, `.vercel/output/static/`, and
`.vercel/output/functions/render.func/server.js`.

There is no faithful local Vercel production runtime, so `pracht preview` exits
with guidance — use `vercel build` or `vercel dev`. Set
`PRACHT_REVALIDATE_TOKEN` at build time when using webhook revalidation; its
Vercel bypass token is embedded in `.prerender-config.json`. Rename the main
Edge Function with `vercelAdapter({ functionName })` if the default `render`
would collide with an ISG route. Custom entries must export the `nodeListener`
created by `createVercelNodeListener(handle)` for Node ISR functions.
When remote MCP is configured, the generated route table sends its endpoint
and OAuth metadata paths to the runtime before method-agnostic SSG rewrites;
keep page routes off the MCP pathname even though the runtime wins that collision.

---

## Static export

```ts
pracht({ adapter: staticAdapter() });
// Dynamic SPA routes: staticAdapter({ fallback: "200.html" }) plus a host
// rewrite for unmatched URLs. If the route or shell exports head(), also set
// generic fallbackHead metadata shared by every rewrite.
```

```bash
pracht build      # dist/client/ is the whole deployment
pracht preview    # local static file server over dist/client/
```

Upload `dist/client/` to any static host. `dist/server/` is build tooling —
never deploy it. The host must serve `<dir>/index.html` for clean URLs and
should use `404.html` as its error document. See <https://pracht.resynapse.dev/docs/adapters#static-export> for host header configuration and the markdown-negotiation and
base-path limitations.

**Eligibility.** Every route must be `render: "ssg"` (or a loaderless,
full-hydration `"spa"`), with no request middleware, API routes, or
HTTP/MCP/WebMCP-exposed capabilities. Anything else fails the build with an
error naming the offenders — that is the signal to pick a serverful adapter.
SSG loaders run only at build time and must produce HTML plus valid JSON route
state; dynamic SSG routes must export `getStaticPaths()`. Only
manifest-registered capabilities participate, and every registered capability
module must load successfully so exposure validation fails closed. The
`notFound` page may set `hydration: "islands"` or `"none"` to keep the client
router out of `404.html` — the router is there only to replace the build URL
with the visitor's, so a 404 that does not name the requested URL pays nothing
for it. `staticAdapter({ fallback })` still requires full hydration there,
because that document is built from the not-found page's route state.

**Deploy base.** Sub-path deploys (GitHub Pages *project* sites, S3 key
prefixes) set Vite `base` to that path. CDN and document-relative bases (`""`,
`"./"`) are build errors — they split assets from the deploy root or resolve
them beneath nested page directories. Under a base, internal navigation must go
through `<Link route>` / `href()`; a hand-written `<a href="/about">` still
means the origin root. Preview and the first-party serverful adapters redirect
the bare base (`/app` → `/app/`) before serving the root document, and custom
adapters get the same behavior via `handlePrachtRequest()`. Framework-owned
browser URLs from the default image loader and the OpenAPI companion artifacts
pick up the base automatically.

**Route state.** Client navigation fetches collision-safe bounded opaque
`.json` files under `_pracht/state/`, for full-hydration SSG routes whose
loader or route/shell `head()` metadata participates in navigation. Equivalent
raw-Unicode and percent-encoded URL segment spellings resolve to the same state
file. Explicitly loaderless and headless routes fetch no state; loaderless
routes with head metadata fetch static state for font-head fragments but still
hit an external API from the browser for live data.

**Build-time collision guards** (all fail the build rather than overwrite):

- A file under `public/_pracht/state/` occupying a generated route-state path.
- A `public/` or Vite-emitted file occupying the generated `404.html` or the
  configured fallback path, including case- or Unicode-normalization-equivalent
  spellings.
- Prerendered pages that do not map to distinct portable filesystem paths:
  duplicate, case-folded, or Unicode-normalization-equivalent outputs;
  Windows-invalid or overlong filename components; file/directory conflicts
  such as `/` against `/index.html`. Fallback names additionally reject Windows
  reserved device names and the portable 255-byte/code-unit component limit.

Pages are written to the percent-decoded output path, matching how static hosts
resolve requests; `pracht preview` decodes request segments the same way.

**SPA fallback.** It only client-renders matched SPA routes. Dynamic SSG paths
omitted by `getStaticPaths()` render the app's not-found page with the
build-time loader data or handled error state carried over from `404.html`. The
host rewrite answers unknown URLs with status 200 (a soft 404), and an app with
no `notFound` page and no unshadowed client-routable SPA catch-all renders them
blank — the build warns about that shape. A dynamic SPA route, its shell, or
the not-found page exporting `head()` requires an explicit `fallbackHead`,
because the shared static document cannot evaluate URL-specific server
metadata; generic `fallbackHead` fonts stay registered while the fallback
commits a loaderless dynamic SPA route.

---

## Pre-flight checklist

1. `pracht build` succeeds and `dist/` looks right.
2. Every secret and config value the loaders need is present in the target
   runtime.
3. `dist/client/` holds prerendered HTML for SSG routes — and for ISG routes,
   except time-revalidated ones on Cloudflare with Workers Caching enabled,
   which render on demand. Webhook-only ISG routes keep build-time snapshots.
4. The ISG manifest exists if ISG is in use: `dist/server/isg-manifest.json`,
   plus `dist/client/_pracht/isg.json` on Cloudflare.
5. API endpoints answer correctly in the production runtime.
6. Auth and redirect middleware behave correctly in production.

$ARGUMENTS
