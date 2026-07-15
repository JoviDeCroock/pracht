---
name: pracht-deploy
version: 1.1.0
description: |
  Pracht deployment guide. Walks through adapter configuration, building, and
  deploying to Node.js, Cloudflare Workers, or Vercel. Handles wrangler config,
  Docker and production checklist.
  Use when asked to "deploy", "set up deployment", "configure adapter",
  "deploy to cloudflare", "deploy to vercel", or "production build".
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
| Vercel             | `@pracht/adapter-vercel`     | Stable |

---

## Node.js Deployment

### Setup

1. Ensure `@pracht/adapter-node` is installed.
2. In `vite.config.ts`:
   ```ts
   import { pracht } from "@pracht/vite-plugin";
   import { nodeAdapter } from "@pracht/adapter-node";
   export default { plugins: [pracht({ adapter: nodeAdapter() })] };
   ```

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

To smoke-test the built worker locally first, run `pracht preview` — it builds and then delegates to `wrangler dev`, which serves the wrangler config's `main` entry, `dist/server/worker.js`.

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "name": "my-pracht-app",
  "main": "dist/server/worker.js",
  "compatibility_date": "2024-01-01",
  "assets": {
    "binding": "ASSETS",
    "directory": "dist/client",
    "run_worker_first": true,
  },
}
```

`"binding": "ASSETS"` and `"run_worker_first": true` are required. Without the binding, the worker's `env.ASSETS` resolves to nothing and the runtime silently falls back to `null` — headers and ISG manifests load empty, so SSG serving, ISG revalidation, and per-route headers all silently no-op. The canonical config lives at `examples/cloudflare/wrangler.jsonc`. If you rename the binding with `assetsBinding` (below), the wrangler `binding` value must match.

### Bindings (KV, D1, R2)

```ts
export async function loader({ context }: LoaderArgs) {
  const value = await context.env.MY_KV.get("key");
  return { value };
}
```

### Custom Assets Binding

```ts
pracht({ adapter: cloudflareAdapter({ assetsBinding: "STATIC" }) });
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
export markdown. See `docs/ADAPTERS.md#cache-key-cardinality`.

Time-revalidated ISG pages then render on demand, are cached at the edge for
their `revalidate` window (stale pages served instantly while the Worker
re-renders in the background), and can be purged early with `purgeCache()` from
`@pracht/adapter-cloudflare/cache`. Webhook-only ISG routes keep their
build-time snapshots and the worker-managed path either way.

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
3. Smoke-test the production runtime before pushing to production. For Node.js and Cloudflare, run `pracht preview`.
4. If the user needs an adapter that isn't installed, help them add it (`pnpm add @pracht/adapter-*`).
5. Don't push to production without the user's explicit confirmation.

$ARGUMENTS
