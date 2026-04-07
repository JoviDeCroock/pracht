---
title: Deployment
lead: previte apps deploy anywhere via platform adapters. Each adapter handles request conversion, asset serving, and ISG storage for its runtime.
breadcrumb: Deployment
prev:
  href: /docs/cli
  title: CLI
next:
  href: /docs/adapters
  title: Adapters Reference
---

## Node.js

The default adapter. Generates a standalone Node.js server with static file serving and ISG support.

```ts [vite.config.ts]
import { previte } from "@previte/vite-plugin";

export default defineConfig({
  plugins: [previte()],
  // adapter defaults to "node"
});
```

```sh
# Build and run
previte build
node dist/server/server.js
```

---

## Cloudflare Workers

Deploys as a Cloudflare Worker with static assets served via the `ASSETS` binding.

```ts [vite.config.ts]
import { cloudflareAdapter } from "@previte/adapter-cloudflare";

export default defineConfig({
  plugins: [previte({ adapter: cloudflareAdapter() })],
});
```

```sh
# Build and deploy
previte build
wrangler deploy
```

Configure bindings (KV, D1, R2) in `wrangler.jsonc`. They are available via `context.env` in loaders and API routes.

---

## Vercel

Deploys as a Vercel Edge Function with static assets served from the CDN.

```ts [vite.config.ts]
import { vercelAdapter } from "@previte/adapter-vercel";

export default defineConfig({
  plugins: [previte({ adapter: vercelAdapter() })],
});
```

```sh
# Build and deploy
previte build
vercel deploy --prebuilt
```

---

## Custom Context

All adapters support a `createContext` option that enriches the context passed to loaders, API routes, and middleware:

```ts
createNodeRequestHandler({
  app: resolvedApp,
  createContext: async ({ request }) => {
    const session = await getSession(request);
    return { session };
  },
});

// In a loader:
export async function loader({ context }: LoaderArgs) {
  const user = context.session?.user;
}
```
