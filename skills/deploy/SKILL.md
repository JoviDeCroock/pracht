---
name: deploy
version: 1.0.0
description: |
  Viact deployment guide. Walks through adapter configuration, building, and
  deploying to Node.js, Cloudflare Workers, or Vercel. Handles wrangler config,
  Docker, preview, and production checklist.
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

# Viact Deploy

Guided adapter setup and deployment for viact applications.

## Step 1: Determine the target

Read `vite.config.ts` and `package.json` first — don't assume the current adapter.
Ask the user where they want to deploy if not already clear from their message.

## Supported Adapters

| Adapter            | Package                     | Status |
| ------------------ | --------------------------- | ------ |
| Node.js            | `@viact/adapter-node`       | Stable |
| Cloudflare Workers | `@viact/adapter-cloudflare` | Stable |
| Vercel             | `@viact/adapter-vercel`     | Stable |

---

## Node.js Deployment

### Setup

1. Ensure `@viact/adapter-node` is installed.
2. In `vite.config.ts`:
   ```ts
   import { viact } from "@viact/vite-plugin";
   export default { plugins: [viact({ adapter: "node" })] };
   ```
3. The default adapter is `"node"`, so this may already be configured.

### Build

```bash
viact build
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

### Preview

```bash
viact preview
```

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

1. Ensure `@viact/adapter-cloudflare` is installed.
2. In `vite.config.ts`:
   ```ts
   import { viact } from "@viact/vite-plugin";
   export default { plugins: [viact({ adapter: "cloudflare" })] };
   ```

### Build & Deploy

```bash
viact build
npx wrangler deploy
```

### Wrangler Configuration

```json
{
  "name": "my-viact-app",
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
viact({ adapter: "cloudflare", cloudflareAssetsBinding: "STATIC" });
```

---

## Vercel Deployment

### Setup

1. Ensure `@viact/adapter-vercel` is installed.
2. In `vite.config.ts`:
   ```ts
   import { viact } from "@viact/vite-plugin";
   export default { plugins: [viact({ adapter: "vercel" })] };
   ```

### Build & Deploy

```bash
viact build
npx vercel deploy --prebuilt
```

Produces: `.vercel/output/config.json`, `.vercel/output/static/`, `.vercel/output/functions/render.func/server.js`

---

## Deployment Checklist

1. **Build**: Run `viact build` and verify `dist/` output.
2. **Environment variables**: Ensure secrets/config needed by loaders are available at runtime.
3. **Static assets**: Verify `dist/client/` contains prerendered HTML for SSG/ISG routes.
4. **ISG routes**: Confirm the ISG manifest exists if using incremental static generation.
5. **API routes**: Test API endpoints work in the production build (`viact preview`).
6. **Middleware**: Verify auth/redirect middleware behaves correctly in production.

## Rules

1. Read `vite.config.ts` and `package.json` before giving advice.
2. Run `viact build` to verify the build succeeds before deploying.
3. Use `viact preview` to smoke-test before pushing to production.
4. If the user needs an adapter that isn't installed, help them add it (`pnpm add @viact/adapter-*`).
5. Don't push to production without the user's explicit confirmation.

$ARGUMENTS
