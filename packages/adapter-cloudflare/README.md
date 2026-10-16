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

To add Durable Objects, Workflows, Cron Triggers, Queue consumers, or code
around each request, write the Worker module yourself and serve pracht from its
`fetch`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter({ workerEntry: "/src/worker.ts" }) })],
});
```

```ts
// src/worker.ts
import { createPrachtHandler } from "@pracht/adapter-cloudflare/worker";

export { Counter } from "./workers/counter.ts";

const pracht = createPrachtHandler();

export default {
  fetch(request, env, ctx) {
    return pracht.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await runCronSweep(env, ctx);
  },
};
```

The default export is the deployed Worker and its named class exports are
deployed beside it; keep their bindings and migrations in `wrangler.jsonc`.
Pass `createContext` to `createPrachtHandler()` to shape the request context.
The older `workerExportsFrom` and `workerHandlersFrom` options still extend the
generated Worker but cannot be combined with `workerEntry`.

## Features

- Converts Cloudflare Worker requests to standard Web Requests
- Static asset serving via `env.ASSETS`
- SSG serving from `env.ASSETS` and ISG revalidation through the Workers Cache API
- Execution context passing for Cloudflare-specific APIs
- App-owned Worker modules via `cloudflareAdapter({ workerEntry })` and
  `createPrachtHandler()` from `@pracht/adapter-cloudflare/worker`
- Generated-entry context factories via `cloudflareAdapter({ createContextFrom })`
- An explicit local-runtime inspector port via `cloudflareAdapter({ inspectorPort })`;
  set it when multiple Cloudflare Vite dev servers may start concurrently, or
  use `false` to disable the inspector
- Local binding-state control via `cloudflareAdapter({ persistState })`; use
  distinct `{ path }` values or `false` for concurrent servers in one project
- Graph-only CLI commands load fail-closed Cloudflare module stubs without
  starting workerd, Miniflare, an inspector, or persistent binding state

## Context factory

Generated entries can import an app-level context factory:

```ts
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

pracht({
  adapter: cloudflareAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, env, executionContext })`.
