---
title: Cloudflare Workers
lead: Build output, Wrangler config, ISG caching, Worker composition, bindings, and WebSockets for `@pracht/adapter-cloudflare`.
---

The Worker serves dynamic routes, the `ASSETS` binding serves static files, and regenerated ISG HTML goes to the Workers Cache API.

| Option | Default | Effect |
| --- | --- | --- |
| `cache` | `false` | Serve ISG through Workers Caching (see [below](#isg-and-workers-caching)) |
| `workerEntry` | none | Your own Worker module (see [Composing the Worker](#composing-the-worker)) |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](/docs/adapters#context-factory)) |
| `assetsBinding` | `"ASSETS"` | Name of the static assets binding |
| `configPath` | Wrangler's lookup | Wrangler config file, such as one [Void](#deploy-with-void) generates |
| `inspectorPort`, `persistState` | automatic, `.wrangler/state` | Local runtime settings for [concurrent dev servers](#build-output) |

## Wrangler config

The `assets` block in `wrangler.jsonc` controls which requests reach the Worker:

```jsonc [wrangler.jsonc]
{
  "name": "my-app",
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"],
  },
}
```

| Key | Why |
| --- | --- |
| `run_worker_first` | Without it, prerendered pages skip the Worker, which stops ISG, Markdown negotiation, and `headers()` exports. `"!/assets/*"` lets hashed files skip it; their headers go to `dist/client/_headers` |
| `html_handling` | Match [`trailingSlash`](/docs/routing#trailing-slashes): `"drop-trailing-slash"` by default or with `"never"`, `"force-trailing-slash"` with `"always"`. `pracht verify` warns on a mismatch |

`pracht build` copies it to `dist/server/wrangler.json` with `main`, bundling rules, and the assets directory added.

## Build output

```
dist/
  client/          // static assets served via ASSETS binding
    assets/
    index.html     // SSG pages
  server/
    worker.js      // Worker entry: default handler and your entrypoint classes
    server.js      // build metadata for the prerender pass
    wrangler.json  // deploy config generated from wrangler.jsonc
```

With named Wrangler environments, run `CLOUDFLARE_ENV=staging pracht build && wrangler deploy`. Deploying with `--env` instead needs `"main": "dist/server/worker.js"`, `"no_bundle": true`, an `ESModule` rule for `"**/*.js"`, and `assets.directory: "dist/client"` in `wrangler.jsonc`.

To run several dev servers at once, give each its own inspector port and state path, or turn them off:

```ts
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

## ISG and Workers caching

By default, regenerated ISG pages live in each data center's Cache API, so a [webhook](/docs/rendering#webhook-revalidation) refreshes one data center. Set `cache` to render time-revalidated routes on demand and purge them everywhere:

```ts [vite.config.ts]
cloudflareAdapter({ cache: true });

// The stale window defaults to one year.
cloudflareAdapter({ cache: { staleWhileRevalidate: 86_400 } });
```

```jsonc [wrangler.jsonc]
{ "cache": { "enabled": true } }
```

Workers Caching keys on the exact path and query string, so query order and trailing slashes create separate entries; keep ISG query shapes bounded. Cached hits skip middleware, so put per-visitor policy on SSR routes.

## Composing the Worker

For Durable Objects, Cron Triggers, Queue consumers, or code around each request, point `workerEntry` at your own Worker module:

```ts [vite.config.ts]
cloudflareAdapter({ workerEntry: "/src/worker.ts" });
```

```ts [src/worker.ts]
import { createPrachtHandler } from "@pracht/adapter-cloudflare/worker";

export { Counter } from "./workers/counter.ts";

const pracht = createPrachtHandler();

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");

    const response = await pracht.fetch(request, env, ctx);
    const wrapped = new Response(response.body, response);
    wrapped.headers.set("x-served-by", "pracht");
    return wrapped;
  },

  async scheduled(controller, env, ctx) {
    await runCronSweep(env, ctx);
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) await processJob(message, env);
  },
};
```

`pracht.fetch()` serves everything the generated Worker does. The other handlers and named class exports such as Durable Objects deploy as written, and `pracht dev` runs the same module.

Pass `createPrachtHandler({ createContext })` to shape the `context` loaders and API routes receive; it defaults to `{ env, executionContext }`. The `workerExportsFrom`, `workerHandlersFrom`, and `createContextFrom` options cannot be combined with `workerEntry`.

## Local preview and Worker bindings

`pracht preview` builds the Worker and runs `wrangler dev`. Bindings come from a gitignored `.dev.vars` file, not from your shell environment (see [Environment variables](/docs/env#local-environment-files)).

A custom-domain route in `wrangler.jsonc` puts that domain in `request.url` on localhost too, changing redirects and the signed `@authority`. To preview without it, run Wrangler with a config holding the [Build output](#build-output) `--env` keys; `pracht preview` ignores `--config`:

```sh
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

## WebSockets

Only the Cloudflare adapter serves WebSocket upgrades through pracht. Forward the handshake from an [API route](/docs/api-routes#websockets) to a Durable Object, which owns the connection:

```ts [src/workers/chat-room.ts]
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  override async fetch(request: Request) {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server); // hibernation-aware
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    for (const peer of this.ctx.getWebSockets()) peer.send(String(message));
  }
}
```

Upgrades work in `pracht dev` too.

## Accessing Cloudflare bindings

Loaders and API routes receive `env` on the context:

```ts
// src/routes/dashboard.tsx
export async function loader({ context }: LoaderArgs) {
  // context.env is the Cloudflare env object
  const user = await context.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return { user };
}
```

Generate an `Env` type from your bindings with `npx wrangler types`, then register it:

```ts [src/env.d.ts]
import "@pracht/core";

declare module "@pracht/core" {
  interface Register {
    context: { env: Env; executionContext: ExecutionContext };
  }
}
```

`create-pracht` apps run it as `cf-typegen` and before `typecheck`.

`import { env } from "cloudflare:workers"` also works. In API and capability modules, read `env.DB` inside the handler or `run()`: graph commands load those modules without bindings, and a top-level read fails with the binding's name.

Bindings do not exist while `pracht build` prerenders SSG and ISG pages, so a read there returns `undefined` and the build prints `Warning: Prerendering read env.DB from cloudflare:workers`. Give pages that need bindings `render: "ssr"`, and use the `waitUntil` your loader receives; the one from `cloudflare:workers` throws while prerendering.

## Deploy with Void

[Void](https://void.cloud/integrations/frameworks/overview) deploys apps built with this adapter and adds `void/db`, `void/kv`, cron jobs, and queues. Add `voidPlugin()` before `pracht()` and point `configPath` at the config Void generates:

```ts [vite.config.ts]
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [
    voidPlugin(),
    pracht({ adapter: cloudflareAdapter({ configPath: "./.void-wrangler.jsonc" }) }),
  ],
});
```

Bindings and compatibility flags then live in `void.config.ts` instead of `wrangler.jsonc`; include `nodejs_als` in `compatibility_flags`. `void deploy` runs `pracht build`. Routes whose loaders use `void/*` helpers need `render: "ssr"`, because prerendering runs without bindings.
