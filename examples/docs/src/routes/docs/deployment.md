---
title: Deployment
lead: pracht apps deploy anywhere via platform adapters. Each adapter handles request conversion, asset serving, and ISG storage for its runtime.
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
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht()],
  // adapter defaults to "node"
});
```

```sh
# Build and run
pracht build
node dist/server/server.js
```

---

## Cloudflare Workers

Deploys as a Cloudflare Worker with static assets served via the `ASSETS` binding.

```ts [vite.config.ts]
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

```sh
# Build and deploy
pracht build
wrangler deploy
```

Configure bindings (KV, D1, R2) in `wrangler.jsonc`. They are available via `context.env` in loaders and API routes.
For Durable Objects, Workflows, and other worker primitives, re-export them
from a dedicated module and pass that module via
`cloudflareAdapter({ workerExportsFrom: "/src/cloudflare.ts" })`.

---

## Vercel

Deploys as a Vercel Edge Function with static assets served from the CDN.

```ts [vite.config.ts]
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [pracht({ adapter: vercelAdapter() })],
});
```

```sh
# Build and deploy
pracht build
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
