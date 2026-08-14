# @pracht/adapter-cloudflare

Cloudflare Workers adapter for pracht. Handles requests in the Workers `fetch` event and serves static assets via `env.ASSETS`.

## Install

```bash
npm install @pracht/adapter-cloudflare
```

## Usage

Select the Cloudflare adapter when scaffolding with `create-pracht`, or add it to an existing project:

```bash
npm create pracht@latest my-app  # choose Cloudflare
```

Deploy with:

```bash
pracht build && wrangler deploy
```

Export named Cloudflare primitives such as Durable Object and Workflow classes
from a dedicated module:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        workerExportsFrom: "/src/cloudflare.ts",
      }),
    }),
  ],
});
```

```ts
// src/cloudflare.ts
export { Counter } from "./workers/counter.ts";
```

Keep the matching bindings and migrations in `wrangler.jsonc`.

Queue consumers, Cron Triggers, Email Routing, and similar default-export
handlers use a separate module configured through `workerHandlersFrom`:

```ts
cloudflareAdapter({
  workerExportsFrom: "/src/cloudflare.ts",
  workerHandlersFrom: "/src/worker-handlers.ts",
});
```

The handlers module should export named `queue`, `scheduled`, `email`, or other
handler functions. Pracht merges them into the Worker's default export next to
its own `fetch` handler; `workerExportsFrom` alone does not install them.

## Features

- Converts Cloudflare Worker requests to standard Web Requests
- Static asset serving via `env.ASSETS`
- SSG serving from `env.ASSETS` and ISG revalidation through the Workers Cache API
- Execution context passing for Cloudflare-specific APIs
- Generated-entry context factories via `cloudflareAdapter({ createContextFrom })`
- An explicit local-runtime inspector port via `cloudflareAdapter({ inspectorPort })`;
  set it when multiple Cloudflare Vite dev servers may start concurrently, or
  use `false` to disable the inspector
- Local binding-state control via `cloudflareAdapter({ persistState })`; use
  distinct `{ path }` values or `false` for concurrent servers in one project
- Graph-only CLI commands load fail-closed Cloudflare module stubs without
  starting workerd, Miniflare, an inspector, or persistent binding state

For framework contributors, `src/index.ts` is the stable public facade.
`adapter.ts` composes the Vite adapter, `server-entry.ts` owns generated Worker
source, and `graph-runtime-stubs.ts` owns the fail-closed Node substitutes used
during graph inspection. Request execution remains in the focused `runtime-*`
modules. Worker-managed ISG serving and regeneration mechanics live in
`runtime-isg-cache.ts`; authenticated webhook batch policy and edge purge
coordination live in `runtime-isg-revalidation.ts`; and `runtime-isg.ts`
preserves their former facade. `cache.ts` separately owns the opt-in Workers
Caching API.

## Context factory

Generated entries can import an app-level context factory:

```ts
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

pracht({
  adapter: cloudflareAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, env, executionContext })`.
