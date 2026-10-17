# Cloudflare Example

This example is wired to Pracht's Cloudflare build target.

## Commands

- `pnpm pracht dev` starts the app with the regular Pracht/Vite development server.
- `pnpm pracht build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/worker.js` as the Worker entry and `dist/server/wrangler.json`
    as the deploy config `wrangler deploy` and `wrangler dev` use, generated
    from `wrangler.jsonc`

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
cron triggers, or any other Cloudflare bindings as needed. `src/worker.ts` is
the Worker module, configured with `cloudflareAdapter({ workerEntry })`: its
default export serves requests through `createPrachtHandler()`, and its named
exports are the Durable Object classes Wrangler binds. Add `queue`, `scheduled`,
or `email` handlers to that default export:

```ts
export default {
  fetch(request, env, ctx) {
    return pracht.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await runCronSweep(env);
  },
};
```

For local secrets, create a gitignored `.dev.vars` file rather than prefixing
`pracht preview` with host environment variables. For example:

```dotenv
REVALIDATE_SECRET=local-only-revalidation-secret
```

Wrangler exposes that value to the Worker binding environment. Set its
production value with `wrangler secret put REVALIDATE_SECRET`. After building:

```bash
pnpm dlx wrangler deploy
```
