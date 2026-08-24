---
name: pracht-deploy
version: 1.2.0
description: |
  Pracht deployment guide. Walks through adapter configuration, building, and
  deploying to Node.js, Cloudflare Workers, Netlify, Vercel, or a pure static
  host. Handles platform config, Docker and production checklist.
  Use when asked to "deploy", "set up deployment", "configure adapter",
  "deploy to cloudflare", "deploy to netlify", "deploy to vercel", "static
  export", or
  "production build".
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

Guided adapter setup and deployment for pracht applications.

## Step 1: Determine the target

Read `vite.config.ts` and `package.json` first — don't assume the current adapter.
Ask the user where they want to deploy if not already clear from their message.

If the pracht MCP server is registered (docs/MCP.md), prefer the `inspect_build`/`doctor`/`verify` MCP tools over shelling out. Note: `inspect_build` (like `pracht inspect build`) needs a prior `pracht build`, and `pracht inspect` requires the pracht plugin registered in the vite config.

## Supported Adapters

| Adapter            | Package                      | Status |
| ------------------ | ---------------------------- | ------ |
| Node.js            | `@pracht/adapter-node`       | Stable |
| Cloudflare Workers | `@pracht/adapter-cloudflare` | Stable |
| Netlify            | `@pracht/adapter-netlify`    | Stable |
| Vercel             | `@pracht/adapter-vercel`     | Stable |
| Static export      | `@pracht/adapter-static`     | Stable |

---

## Node.js Deployment

### Setup

1. Ensure `@pracht/adapter-node` is installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { nodeAdapter } from "@pracht/adapter-node";
   export default {
     plugins: [
       pracht({
         adapter: nodeAdapter({ canonicalOrigin: "https://app.example.com" }),
       }),
     ],
   };
   ```

Pin `canonicalOrigin` in production so `request.url` does not depend on the
incoming `Host` header. `maxBodySize` is also available on `nodeAdapter()`.
Only custom entries behind a trusted proxy that overwrites forwarded headers
should use `createNodeRequestHandler({ trustProxy: true })`.
If that proxy strips Vite's deploy base from the forwarded path, set
`nodeAdapter({ basePathStripped: true })` (or the same option on a custom
`createNodeRequestHandler`). Do not infer this from the first path segment: a
route may legitimately begin with the same segment as the deploy base. The
adapter restores the public base before `createContext()`, loaders, and API
handlers receive the request.
The proxy must also own the public bare-base redirect (`/app` to `/app/`) in
this mode because the stripped origin cannot distinguish it from a legitimate
base-free `/app` route.

The Node adapter compresses responses by default (brotli/gzip negotiated via
`Accept-Encoding`, streaming for dynamic bodies, an in-memory LRU for static
assets). When the deployment sits behind a reverse proxy or CDN that already
compresses responses, set `nodeAdapter({ compression: false })` so bodies are
not compressed twice.

### Build

```bash
pracht build
```

Produces:

- `dist/client/` — static assets (JS, CSS, prerendered HTML)
- `dist/server/server.js` — Node server entry
- `dist/server/isg-manifest.json` — ISG revalidation config (if ISG routes exist)
- `dist/client/.vite/manifest.json` — asset manifest for script/style injection

### Run

```bash
node dist/server/server.js
```

Port 3000 by default. For a local production smoke test, `pracht preview` builds and runs the server in one step (`--port <n>`, `--skip-build` to reuse an existing build). For production: reverse proxy (nginx, Caddy), process manager (PM2, systemd), `NODE_ENV=production`.

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY dist/ dist/
COPY package.json .
EXPOSE 3000
CMD ["node", "dist/server/server.js"]
```

---

## Cloudflare Workers Deployment

### Setup

1. Ensure `@pracht/adapter-cloudflare` is installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
   export default { plugins: [pracht({ adapter: cloudflareAdapter() })] };
   ```

### Build & Deploy

```bash
pracht build
npx wrangler deploy
```

To smoke-test the built worker locally first, run `pracht preview` — it builds and then delegates to `wrangler dev`, which serves the wrangler config's `main` entry, `dist/server/worker.js`. Keep `no_bundle: true` and the JavaScript `ESModule` rule: Pracht's Vite output is already bundled and can contain lazy server chunks that Wrangler must upload separately.

Wrangler owns the Worker's binding environment. Put local-only secrets such as
`PRACHT_CONFIRMATION_SECRET` and `PRACHT_REVALIDATE_TOKEN` in a gitignored
`.dev.vars`; prefixing the host command with those variables does not
automatically expose them inside the Worker. Keep production values in
`wrangler secret`.

If the config contains a custom-domain route, preview can listen on localhost
while `request.url` inside the Worker uses the custom domain. Sign that
effective `@authority` for Web Bot Auth or temporarily disable the route. To use
a separate local config, build first, then run:

```bash
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

The local config must keep `main: "dist/server/worker.js"`, keep
`no_bundle: true`, include the JavaScript `ESModule` rule, and omit the
production route. `pracht preview` does not forward Wrangler's `--config`
flag.

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "name": "my-pracht-app",
  "main": "dist/server/worker.js",
  "no_bundle": true,
  "rules": [{ "type": "ESModule", "globs": ["**/*.js", "**/*.mjs"] }],
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    "directory": "dist/client",
    "run_worker_first": true,
  },
}
```

`"no_bundle": true`, the JavaScript `ESModule` rule, `"binding": "ASSETS"`, and `"run_worker_first": true` are required. Without the first two settings, Wrangler either re-bundles Pracht's Vite output and folds lazy server chunks into the entry or omits those chunks from the upload. Without the binding, the worker's `env.ASSETS` resolves to nothing and the runtime silently falls back to `null` — headers and ISG manifests load empty, so SSG serving, ISG revalidation, and per-route headers all silently no-op. The canonical config lives at `examples/cloudflare/wrangler.jsonc`. If you rename the binding with `assetsBinding` (below), the wrangler `binding` value must match.

### Bindings (KV, D1, R2)

```ts
export async function loader({ context }: LoaderArgs) {
  const value = await context.env.MY_KV.get("key");
  return { value };
}
```

Keep Cloudflare binding reads inside the loader, API handler, capability
`run()`, or another request-time function. Although Workers permits top-level
`env.MY_KV`, Pracht graph inspection intentionally fails such module-initializer
reads because it cannot supply an authoritative binding without risking false
graph metadata.

### Custom Assets Binding

```ts
pracht({ adapter: cloudflareAdapter({ assetsBinding: "STATIC" }) });
```

### Named bindings and default-export handlers

Durable Object and Workflow classes are named Worker exports. Re-export them
from the module configured with `workerExportsFrom`. Queue consumers, Cron
Triggers, and Email Routing are instead methods on the default export; expose
named `queue`, `scheduled`, or `email` functions from the module configured
with `workerHandlersFrom`:

```ts
cloudflareAdapter({
  workerExportsFrom: "/src/cloudflare.ts",
  workerHandlersFrom: "/src/worker-handlers.ts",
});
```

### ISG via Workers Caching

ISG works out of the box: without any cache option, the default worker-managed path serves the build-time snapshot, detects staleness, and regenerates pages in the background via the Workers Cache API — per colo — and `POST /__pracht/revalidate` triggers on-demand regeneration. Enabling `cache: true` moves ISG from that per-colo worker-managed path to edge-tier Workers Caching, on both sides:

```ts
pracht({ adapter: cloudflareAdapter({ cache: true }) });
```

```jsonc
// wrangler.jsonc
{ "cache": { "enabled": true } }
```

Before enabling it, audit ISG URLs for unbounded query strings. Workers Caching
keys the exact path and query string, including parameter order and trailing
slashes; use a bounded query allowlist/canonical redirect or an uncached gateway
with a pathname-only `cf.cacheKey`, and normalize `Accept` there for routes that
export markdown or declare `markdown: true` for middleware-owned negotiation.
See `docs/ADAPTERS.md#cache-key-cardinality`.

Time-revalidated ISG pages then render on demand, are cached at the edge for
their `revalidate` window (stale pages served instantly while the Worker
re-renders in the background), and can be purged early with `purgeCache()` from
`@pracht/adapter-cloudflare/cache`. Webhook-only ISG routes keep their
build-time snapshots and the worker-managed path either way.

---

## Netlify Deployment

### Setup

1. Ensure `@pracht/adapter-netlify` and `netlify-cli` are installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { netlifyAdapter } from "@pracht/adapter-netlify";
   export default { plugins: [pracht({ adapter: netlifyAdapter() })] };
   ```
3. Add `netlify.toml`:
   ```toml
   [build]
     command = "pnpm build"
     publish = "dist/client"

   [functions]
     directory = "netlify/functions"
   ```

### Build, Preview, and Deploy

```bash
npx pracht build && npx netlify dev
npx netlify deploy --build --prod
```

The build emits `netlify/functions/pracht.mjs`. Page requests go through that
function so Markdown negotiation and route-state requests remain correct;
hashed assets bypass it and stay outside the function bundle at the origin
root. With a Vite deploy base, the function instead bundles and serves the
base-free asset and `/_pracht` trees so `/app/...` requests remain inside the
mount. Custom `excludedPath` entries still bypass their literal origin-root
URLs, but matching files remain bundled for base-prefixed requests. The
generated config enumerates only client files the function can serve and roots
applicable exclusions at the function file so Netlify's tracer cannot re-add
bypassed trees. Netlify durable caching
implements time-based ISG and per-path cache tags implement authenticated
webhook revalidation. A trailing-slash ISG document request permanently
redirects to the canonical slashless URL before rendering, and webhook
revalidation normalizes either spelling before purging the cache tag.
Only `Cache-Control`, `CDN-Cache-Control`, and `Netlify-CDN-Cache-Control`
override the adapter's cache defaults; provider-specific headers for another
CDN do not. Set a cache window to `0` to disable stale serving or freshness.
`Netlify-Vary` owns route-state variants, while the standard `Vary: Accept`
header owns Markdown negotiation. Cacheable negotiated SSG representations use
the same `Netlify-Vary` instructions as their prerendered HTML. Shared ISG
renders strip visitor-specific request data and Netlify context metadata before
loaders or context factories run.

`pracht preview` exits with guidance because it cannot emulate Netlify's
Functions and CDN behavior. Build the generated function before using
`netlify dev` for the platform-shaped local runtime. Configure
`PRACHT_REVALIDATE_TOKEN` in Netlify when webhook revalidation is enabled.

---

## Vercel Deployment

### Setup

1. Ensure `@pracht/adapter-vercel` is installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { vercelAdapter } from "@pracht/adapter-vercel";
   export default { plugins: [pracht({ adapter: vercelAdapter() })] };
   ```

### Build & Deploy

```bash
pracht build
npx vercel deploy --prebuilt
```

Produces: `.vercel/output/config.json`, `.vercel/output/static/`, `.vercel/output/functions/render.func/server.js`

There is no faithful local Vercel production runtime, so `pracht preview`
exits with guidance. Use `vercel build` or `vercel dev`. Set
`PRACHT_REVALIDATE_TOKEN` at build time when using webhook revalidation; its
Vercel bypass token is embedded in `.prerender-config.json`. Rename the main
Edge Function with `vercelAdapter({ functionName })` if its default `render`
name would collide with an ISG route. Custom entries must export the
`nodeListener` created by `createVercelNodeListener(handle)` for Node ISR
functions.

---

## Static Export Deployment

For apps where every route is `render: "ssg"` (or loaderless, full-hydration
`"spa"`), with no
request middleware, API routes, or HTTP/MCP/WebMCP-exposed capabilities. SSG
loaders run only at build time and must produce HTML plus valid JSON route
state; dynamic SSG routes must export `getStaticPaths()`. Anything else fails the build with an error naming the
offenders — that is the signal to pick a serverful adapter instead. Only
manifest-registered capabilities participate; every registered capability
module must load successfully so exposure validation can fail closed. The
`notFound` page must use full hydration (the default), because the shared
`404.html` needs the client router to adopt the visitor's actual URL. Sub-path
deploys (GitHub Pages *project* sites, S3 key prefixes) set Vite `base` to that
path; CDN and document-relative bases (`""` / `"./"`) are build errors,
because they split assets from the deploy root or resolve them beneath nested
page directories. Under a base,
internal navigation must go through `<Link route>` / `href()` — a hand-written
`<a href="/about">` still means the origin root.
Pracht's preview and first-party serverful adapters redirect the bare base
(`/app`) to its trailing-slash form (`/app/`) before serving the root document;
custom adapters receive the same behavior through `handlePrachtRequest()`.
Framework-owned browser URLs from the default image loader and OpenAPI
companion artifacts pick up the same base automatically.

### Setup

1. Ensure `@pracht/adapter-static` is installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { staticAdapter } from "@pracht/adapter-static";
   export default { plugins: [pracht({ adapter: staticAdapter() })] };
   // With dynamic SPA routes, add { fallback: "200.html" } and configure the
   // host to rewrite unmatched URLs to it. If the route or shell exports
   // head(), also set generic fallbackHead metadata shared by every rewrite.
   ```

### Build & Deploy

```bash
pracht build      # dist/client/ is the whole deployment
pracht preview    # local static file server over dist/client/
```

Upload `dist/client/` to any static host (GitHub Pages, S3, nginx, Netlify).
`dist/server/` is build tooling only — never deploy it. The host must serve
`<dir>/index.html` for clean URLs and should use `404.html` as its error
document. A static `notFound` page must use full hydration so that shared
document can adopt the visitor's real URL. Client navigation fetches collision-safe
bounded opaque `.json` files under `_pracht/state/` for full-hydration SSG
routes whose loader or route/shell `head()` metadata participates in navigation;
equivalent raw-Unicode and percent-encoded URL segment spellings resolve to the
same state file. Explicitly loaderless and headless routes fetch no Pracht
state; loaderless routes with head metadata fetch static state for font-head
fragments but still use browser-side requests to an external API for live
data. Files under `public/_pracht/state/` may not occupy a generated
route-state path; the build rejects the collision instead of overwriting the
public file. Files copied from `public/` or emitted by Vite also may not occupy
the generated `404.html` or configured fallback path, including a case- or
Unicode-normalization-equivalent spelling; the build rejects the portable
collision instead of overwriting existing output. Generic `fallbackHead` fonts
remain registered while the fallback commits a loaderless dynamic SPA route.
See docs/ADAPTERS.md § Static Adapter for host header
configuration and limitations (markdown negotiation, base paths). Pages are
written to the percent-decoded output path, matching how static hosts resolve
requests; `pracht preview` decodes request segments the same way. The SPA fallback only client-renders matched SPA routes; dynamic
SSG paths omitted by `getStaticPaths()` render the app's not-found page with
the build-time loader data or handled error state carried over from `404.html`.
The host rewrite that serves the fallback answers unknown URLs with status 200 (soft 404), and an app
with no `notFound` page and no unshadowed client-routable SPA catch-all renders them blank — the build
warns about that shape. A dynamic SPA route, its shell, or the not-found page
with `head()` requires an explicit `fallbackHead`, because the shared static
document cannot evaluate URL-specific server metadata. Prerendered pages must
map to distinct portable filesystem paths; duplicate/case-folded or
Unicode-normalization-equivalent outputs, Windows-invalid or overlong filename
components, and file/directory conflicts such as `/` with `/index.html` fail
before any page is written. Fallback names likewise reject Windows reserved
device names and the portable 255-byte/code-unit component limit.

---

## Deployment Checklist

1. **Build**: Run `pracht build` and verify `dist/` output.
2. **Environment variables**: Ensure secrets/config needed by loaders are available at runtime.
3. **Static assets**: Verify `dist/client/` contains prerendered HTML for SSG routes (and ISG routes — except time-revalidated ISG routes on Cloudflare with Workers Caching enabled, which render on demand; webhook-only ISG routes keep their build-time snapshots).
4. **ISG routes**: Confirm the ISG manifest (`dist/server/isg-manifest.json`; on Cloudflare also `dist/client/_pracht/isg.json`) exists if using incremental static generation.
5. **API routes**: Test API endpoints work in the production runtime. For Node.js, run `pracht preview` (or `node dist/server/server.js`).
6. **Middleware**: Verify auth/redirect middleware behaves correctly in production.

## Rules

1. Read `vite.config.ts` and `package.json` before giving advice.
2. Run `pracht build` to verify the build succeeds before deploying.
3. Smoke-test the production runtime before pushing to production. For Node.js and Cloudflare, run `pracht preview`; for Netlify, run `pracht build && netlify dev`.
4. If the user needs an adapter that isn't installed, help them add it (`pnpm add @pracht/adapter-*`).
5. Don't push to production without the user's explicit confirmation.

$ARGUMENTS
