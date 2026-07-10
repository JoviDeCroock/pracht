# Cloudflare Example

This example is wired to Pracht's Cloudflare build target.

## Commands

- `pnpm pracht dev` starts the app with the regular Pracht/Vite development server.
- `pnpm pracht build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/server.js` as the Worker bundle and `dist/server/worker.js` as
    the deploy entry (`main` in `wrangler.jsonc`)

## ISG via Workers Caching

The adapter is configured with `cache: true`, and `wrangler.jsonc` enables
[Workers Caching](https://developers.cloudflare.com/workers/cache/) with
`"cache": { "enabled": true }`. The `/pricing` route
(`render: "isg"`, `revalidate: timeRevalidate(3600)`) is rendered on demand
and cached in front of the Worker for an hour; after that, visitors keep
getting the cached page instantly while the Worker re-renders it in the
background.

`src/api/revalidate.ts` shows webhook-based revalidation — purge a route's
cached pages ahead of schedule. The endpoint requires a shared secret
(`wrangler secret put REVALIDATE_SECRET`, or `.dev.vars` locally) and
returns 401 without it:

```bash
curl -X POST https://your-worker.example.workers.dev/api/revalidate \
  -H 'content-type: application/json' \
  -H "x-revalidate-secret: $REVALIDATE_SECRET" \
  --data '{"route":"pricing"}'
```

## Deploy

The `wrangler.jsonc` in this directory is yours to edit — add KV, D1, R2,
cron triggers, or any other Cloudflare bindings as needed. Re-export Durable
Objects, Workflows, or Queues from `src/cloudflare.ts` so Wrangler can discover
them from the generated Worker entry. After building:

```bash
pnpm dlx wrangler deploy
```
