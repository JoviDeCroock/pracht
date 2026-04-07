---
title: Deployment
lead: viact apps deploy anywhere via platform adapters. Each adapter handles request conversion, asset serving, and ISG storage for its runtime.
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
import { viact } from "@viact/vite-plugin";

export default defineConfig({
  plugins: [preact(), viact()],
  // adapter defaults to "node"
});
```

```sh
# Build and run
viact build
node dist/server/server.js
```

---

## Cloudflare Workers

Deploys as a Cloudflare Worker with static assets served via the `ASSETS` binding.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [preact(), viact({ adapter: "cloudflare" })],
});
```

```sh
# Build and deploy
viact build
wrangler deploy
```

Configure bindings (KV, D1, R2) in `wrangler.jsonc`. They are available via `context.env` in loaders and actions.

---

## Vercel

Deploys as a Vercel Edge Function with static assets served from the CDN.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [preact(), viact({ adapter: "vercel" })],
});
```

```sh
# Build and deploy
viact build
vercel deploy --prebuilt
```

---

## Custom Context

All adapters support a `createContext` option that enriches the context passed to loaders, actions, and middleware:

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
