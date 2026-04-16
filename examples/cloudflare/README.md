# Cloudflare Example

This example is wired to Pracht's Cloudflare build target.

## Commands

- `pnpm pracht dev` starts the app with the regular Pracht/Vite development server.
- `pnpm pracht build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/server.js` as the Worker bundle

## Deploy

The `wrangler.jsonc` in this directory is yours to edit — add KV, D1, R2,
cron triggers, or any other Cloudflare bindings as needed. Re-export Durable
Objects, Workflows, or Queues from `src/cloudflare.ts` so Wrangler can discover
them from the generated Worker entry. After building:

```bash
pnpm dlx wrangler deploy
```
