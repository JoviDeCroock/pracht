---
name: configure-isg
version: 1.0.0
description: |
  Wire ISG (incremental static generation) revalidation correctly for the
  project's adapter: route-level timeRevalidate/webhookRevalidate policies,
  the authenticated /__pracht/revalidate webhook, Cloudflare Workers Caching,
  Vercel native ISR, and cache-key pitfalls — then verify it locally.
  Use when asked to "set up ISG", "configure revalidation", "add a
  revalidation webhook", "my ISG page never updates", or "cache this page at
  the edge".
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Configure ISG

ISG renders at build time and regenerates after a time window or an
authenticated webhook (`docs/RENDERING_MODES.md`, `docs/ADAPTERS.md`). The
mechanics differ per adapter, and a route with `render: "isg"` but **no
`revalidate` policy never regenerates** — the prerenderer only writes an ISG
manifest entry when a policy exists. This skill wires the policy, the
webhook, and the adapter-specific cache correctly.

## Step 1: Identify adapter and candidate routes

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

```bash
pracht inspect routes --json    # render + revalidate per route
pracht inspect build --json     # adapterTarget (requires a prior `pracht build`)
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up. If unsure *which* routes deserve ISG at all, run
`/tune-render-mode` first — this skill assumes the mode choice is made.

## Step 2: Wire the revalidate policy (manifest router)

```typescript
// src/routes.ts
import { timeRevalidate, webhookRevalidate } from "@pracht/core";

route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: [timeRevalidate(3600), webhookRevalidate()],
});
```

- `timeRevalidate(seconds)` — requires a positive **integer**; anything else
  throws at manifest evaluation.
- `webhookRevalidate()` — no arguments; opts the route into the webhook
  endpoint.
- `revalidate` accepts one policy or an array (`RouteRevalidate`); the array
  above means "hourly, or sooner when a webhook names this path".

**Pages router caveat:** `export const RENDER_MODE = "isg"` exists, but there
is no `REVALIDATE` page constant — the pages scanner only extracts
`RENDER_MODE` and `HYDRATION`, so pages-router ISG routes are frozen
build-time snapshots. To attach a policy, eject to an explicit manifest with
`generateRoutesFile` from `@pracht/vite-plugin/pages-router` (see
docs/ROUTING.md "Ejecting to Explicit Manifest") and edit the generated route.

For dynamic routes, `getStaticPaths()` enumerates the prerendered params.
Paths it did not enumerate render per-request without a cached copy, and
webhooks naming them are `skipped` on Node/Cloudflare (nothing to refresh).

## Step 3: The revalidation webhook

All adapters expose `POST /__pracht/revalidate` (`PRACHT_REVALIDATE_ENDPOINT`
from `@pracht/core`):

```sh
curl -X POST https://example.com/__pracht/revalidate \
  -H "Authorization: Bearer $PRACHT_REVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["/pricing"]}'
```

- Auth: `PRACHT_REVALIDATE_TOKEN` env var; fails closed with `401` when unset
  or wrong. Providers that can't send bearer auth may use the
  `x-pracht-revalidate-token` header instead.
- Body: `paths` array, max 64 entries (else `400`). Response reports
  `revalidated` / `skipped` / `failed` arrays; failed paths keep serving the
  previous copy. Regeneration is single-flighted per path and never replays
  the caller's cookies/auth headers.

## Step 4: Adapter mechanics

| Adapter | Time revalidation | Webhook revalidation |
| ------- | ----------------- | -------------------- |
| Node | File mtime vs window; serves stale, refreshes in background | Regenerates the on-disk HTML synchronously |
| Cloudflare (default) | Worker-managed Cache API timestamp, `env.ASSETS` fallback — **per colo** | Overwrites the Cache API entry in the receiving colo only |
| Cloudflare (`cache: true`) | Edge-tier Workers Caching in front of the Worker for time-revalidated routes | Webhook-only routes keep the worker-managed path; time+webhook routes also get their edge entry purged |
| Vercel | Build Output prerender functions: `.prerender-config.json` with `expiration` from the time policy and build HTML as fallback | `x-vercel-cache`-verified bypass; `PRACHT_REVALIDATE_TOKEN` becomes the `bypassToken` and **must be set at build time** (runtime-only setting → webhook paths report `failed` until you rebuild) |

Cloudflare specifics (`docs/ADAPTERS.md#isg-via-workers-caching-cache`):

- The default per-colo path needs **no extra config**. The `cache: true`
  upgrade needs both `cloudflareAdapter({ cache: true })` in vite config
  (optionally `{ cache: { staleWhileRevalidate: <seconds> } }`) **and**
  `{ "cache": { "enabled": true } }` in wrangler config.
- With it on, time-revalidated pages are no longer emitted as build-time
  snapshots (first request after deploy renders cold); webhook-only routes
  keep their snapshots.
- Programmatic purge: `purgeCache` / `routeCacheTag` from
  `@pracht/adapter-cloudflare/cache` — protect any purge API route with a
  secret.
- Cache safety: responses with `Set-Cookie`, `Cache-Control:
  private`/`no-store`, or `Vary: Cookie`/`Authorization`/`*` are never stored
  in the shared edge cache.

## Step 5: Cache-key cardinality caveats

See `docs/ADAPTERS.md#cache-key-cardinality`. Node and worker-managed
Cloudflare ISG key generated pages by **pathname**. Workers Caching keys by
exact path **plus query string** (param order and trailing slash included), so
`/pricing?ref=a` and `/pricing?ref=b` are independent entries with independent
revalidation — and attacker-chosen query values create unbounded cold entries.
Before enabling `cache: true`, canonicalize or reject stray query params (the
docs describe an uncached-gateway pattern), and note that routes exporting
`markdown` carry `Vary: Accept`, which multiplies variants per `Accept`
string. Vercel prerender functions are generated with `allowQuery: []`, so
query strings do not fragment that cache. Middleware never runs for cached ISG
hits on any adapter — keep per-visitor logic on SSR routes.

## Step 6: Verify locally

- **Node**: `PRACHT_REVALIDATE_TOKEN=dev-secret pracht preview --port 3000`
  (builds, then runs `dist/server/server.js` with inherited env;
  `--skip-build` reuses a build). Then curl the Step 3 command against
  `localhost:3000` and check the JSON reports your path under `revalidated`;
  re-fetch the page and confirm the change. For time policies, use a short
  window (e.g. `timeRevalidate(5)`), request after expiry — first response is
  the stale copy, the next one is fresh.
- **Cloudflare**: `pracht preview` delegates to `wrangler dev`; put
  `PRACHT_REVALIDATE_TOKEN` in `.dev.vars` so the worker sees it.
- **Vercel**: no faithful local production runtime — `pracht preview` points
  at `vercel build`/`vercel dev`; verify webhook behavior on a real
  deployment built with `PRACHT_REVALIDATE_TOKEN` set.

Finish with the standard gate — and run `/pre-deploy` before shipping:

```bash
pracht verify --json
pracht typegen   # if src/routes.ts changed
```

## Rules

1. Never overwrite `wrangler.jsonc`/`wrangler.toml` or `vercel.json` — diff
   and merge, confirming collisions with `AskUserQuestion`.
2. Never propose ISG for personalized responses: `Set-Cookie` or
   `Cache-Control: private`/`no-store` output fails regeneration, and
   `Vary: Cookie`/`Authorization`/`*` is kept out of shared caches by design.
3. Always pair `render: "isg"` with an explicit `revalidate` policy — without
   one the route silently behaves like SSG.
4. On Vercel, set `PRACHT_REVALIDATE_TOKEN` in the build environment, not
   just at runtime.
5. Cloudflare webhook invalidation on the default path is per-colo, not a
   global purge — use shorter time windows (or `cache: true` + purge) when
   global freshness matters.

$ARGUMENTS
