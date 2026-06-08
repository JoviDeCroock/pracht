---
title: Deployment
lead: pracht apps deploy anywhere via platform adapters. Each adapter handles request conversion and asset serving for its runtime; Node also supports runtime ISG revalidation.
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

## Void

Deploys a Pracht-owned Worker and static assets through Void.

```ts [vite.config.ts]
import { voidAdapter } from "@pracht/adapter-void";

export default defineConfig({
  plugins: [pracht({ adapter: voidAdapter() })],
});
```

```json [void.json]
{
  "$schema": "./node_modules/void/schema.json",
  "worker": {
    "compatibility_date": "2026-02-24",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

```sh
# Build and deploy existing output
pracht build
void deploy --skip-build
```

Void can infer and provision D1, KV, R2, and AI bindings from source usage.
Pracht loaders and API routes receive those bindings as `context.env`; the
adapter also wraps requests so `void/db`, `void/kv`, `void/storage`, and
`void/env` resolve default bindings. Void-managed auth routes are not automatic
because Pracht still owns routing.

---

## Custom Context

Generated adapter entries can import a context factory that enriches the context passed to loaders, API routes, and middleware:

```ts [vite.config.ts]
import { nodeAdapter } from "@pracht/adapter-node";

export default defineConfig({
  plugins: [
    pracht({
      adapter: nodeAdapter({ createContextFrom: "/src/server/context.ts" }),
    }),
  ],
});
```

```ts [src/server/context.ts]
export async function createContext({ request }: { request: Request }) {
  const session = await getSession(request);
  return { session };
}

// In a loader:
export async function loader({ context }: LoaderArgs) {
  const user = context.session?.user;
}
```
