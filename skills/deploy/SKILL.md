---
name: deploy
version: 1.0.0
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

Port 3000 by default. For production: reverse proxy (nginx, Caddy), process manager (PM2, systemd), `NODE_ENV=production`.

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

### Wrangler Configuration

```json
{
  "name": "my-pracht-app",
  "main": "dist/server/server.js",
  "compatibility_date": "2024-01-01",
  "assets": { "directory": "dist/client" }
}
```

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
3. **Static assets**: Verify `dist/client/` contains prerendered HTML for SSG/ISG routes.
4. **ISG routes**: Confirm the ISG manifest exists if using incremental static generation.
5. **API routes**: Test API endpoints work in the production runtime. For Node.js, run `node dist/server/server.js`.
6. **Middleware**: Verify auth/redirect middleware behaves correctly in production.

## Rules

1. Read `vite.config.ts` and `package.json` before giving advice.
2. Run `pracht build` to verify the build succeeds before deploying.
3. Smoke-test the production runtime before pushing to production. For Node.js, run `node dist/server/server.js`.
4. If the user needs an adapter that isn't installed, help them add it (`pnpm add @pracht/adapter-*`).
5. Don't push to production without the user's explicit confirmation.

$ARGUMENTS
