---
title: Adapters
lead: Adapters are thin layers that translate between a platform's native request handling and pracht's Web Request/Response interface. pracht ships adapters for Cloudflare Workers, Vercel Edge Functions, and Node.js.
breadcrumb: Adapters
prev:
  href: /docs/deployment
  title: Deployment
next:
  href: /docs/prefetching
  title: Prefetching
---

## Architecture

Every adapter follows the same request flow:

```
Platform request (Node / CF / Vercel)
  → Convert to Web Request
  → Is this a static asset?  → Yes: serve from dist/client/
  → Is this a prerendered page?  → Yes: serve static HTML or the platform's ISG cache
  → Delegate to handlePrachtRequest()
  → Convert Web Response back to platform response
```

Adapters also preserve route and shell document headers for prerendered HTML so static SSG/ISG responses match dynamic document responses.

For prerendered routes that export `markdown`, the Node and Cloudflare adapters bypass the static document only when the request prefers `text/markdown` over HTML and the exact route appears in the generated Markdown manifest. Routes without a markdown representation stay on the static fast path even when an agent requests markdown; SSR-only builds emit an empty manifest so public assets receive the same protection, while custom entries without manifest metadata preserve negotiation by falling through to the framework.

---

## Cloudflare Workers

Deploy to Cloudflare's global edge network. Static assets are served from the
`ASSETS` binding, dynamic routes are handled by the Worker, and regenerated ISG
HTML is stored in the Workers Cache API with `ASSETS` as the build-time
fallback.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

```json [package.json]
{
  "dependencies": {
    "@pracht/core": "*",
    "@pracht/adapter-cloudflare": "*"
  }
}
```

### Build output

Running `pracht build` with the Cloudflare adapter emits:

```
dist/
  client/          // static assets served via ASSETS binding
    assets/
    index.html     // SSG pages
  server/
    server.js      // Worker bundle used for the build/prerender pass
    worker.js      // clean Wrangler deploy entry
```

Prerendered HTML receives document headers from the generated `_pracht/headers.json` asset.

Every shared-cache ISG render, including a cold render with `cloudflareAdapter({ cache: true })`, uses a sanitized request: path only, a canonical HTML or markdown `Accept` header, and no cookies, credentials, query string, or body. This prevents the visitor who triggers the render from personalizing the stored response.

Keep your `wrangler.jsonc` in the project root so you can add bindings without the build overwriting them.

Cloudflare chooses a local inspector port automatically in dev. Concurrent
Vite dev servers can race that availability probe, so give each server a
distinct port (or disable the inspector). Local binding state also needs a
distinct persistence path or must be disabled:

```ts
cloudflareAdapter({ inspectorPort: 9230 });
cloudflareAdapter({ inspectorPort: false, persistState: false });
cloudflareAdapter({ persistState: { path: ".wrangler/state-dev-a" } });
```

### ISG and Workers Caching

By default, Cloudflare runtime ISG stores regenerated pages in the per-colo
Cache API and uses `ASSETS` as its build-time fallback. Opt into Cloudflare's
cache in front of the Worker when time-revalidated routes should render on
demand at the edge:

```ts [vite.config.ts]
cloudflareAdapter({ cache: true });

// The stale window defaults to one year and is independently configurable.
cloudflareAdapter({ cache: { staleWhileRevalidate: 86_400 } });
```

```jsonc [wrangler.jsonc]
{ "cache": { "enabled": true } }
```

Workers Caching keys the exact path and query string. Query ordering and
trailing slashes therefore create distinct cache entries, and arbitrary query
values can create unbounded cold renders. Keep shared ISG query shapes bounded
and canonical; use SSR when query parameters or visitor credentials affect the
render. Cached hits also bypass middleware, so per-visitor policy belongs on
SSR routes.

The assets binding's default HTML handling may redirect a nested prerendered
route from `/guide` to `/guide/`, while Node serves `/guide` directly. Set
`assets.html_handling` in `wrangler.jsonc` when the same canonical URL must be
preserved across adapters.

### Exporting bindings and event handlers

Wrangler discovers class-based primitives such as Durable Objects and
Workflows from named exports on the Worker entry. Point the adapter at a
dedicated module that re-exports them:

```ts [vite.config.ts]
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

```ts [src/cloudflare.ts]
export { Counter } from "./workers/counter.ts";
```

Keep the matching bindings and migrations in `wrangler.jsonc`.

Queue consumers, Cron Triggers, Email Routing, and similar events are methods
on the Worker's **default export**, not named exports. Export those handlers by
name from a second module and point `workerHandlersFrom` at it:

```ts [vite.config.ts]
cloudflareAdapter({
  workerExportsFrom: "/src/cloudflare.ts",
  workerHandlersFrom: "/src/worker-handlers.ts",
});
```

```ts [src/worker-handlers.ts]
export async function queue(batch, env, ctx) {
  for (const message of batch.messages) await processJob(message, env);
}

export async function scheduled(event, env, ctx) {
  await runCronSweep(env, ctx);
}
```

Pracht merges these methods beside its own `fetch` handler. A `fetch` export in
the handler module is ignored; request handling belongs in API routes or
middleware.

### Local preview and Worker bindings

`pracht preview` builds the Worker and delegates to `wrangler dev`. Local
Worker secrets must come through Wrangler, for example from a gitignored
`.dev.vars` file:

```dotenv [.dev.vars]
PRACHT_CONFIRMATION_SECRET=local-only-secret
PRACHT_REVALIDATE_TOKEN=local-only-revalidation-token
```

Prefixing the host command with either variable does not automatically expose
it on the Worker's `env` binding. Keep production values in `wrangler secret`.

When the Wrangler config includes a custom-domain route, preview may print a
localhost URL while the `Request` inside the Worker uses the custom domain in
`request.url`. Web Bot Auth signatures cover `@authority`, so sign that
effective Worker authority or temporarily disable the custom route. To select
a separate config, build and invoke Wrangler directly:

```sh
pracht build
npx wrangler dev --config wrangler.local.jsonc --port 3000
```

That config must keep `main: "dist/server/worker.js"` and omit the production
route. `pracht preview` does not forward Wrangler's `--config` flag. The same
authority distinction affects absolute redirects and other origin-derived
behavior.

### WebSockets

Cloudflare is the one adapter that can serve WebSocket upgrades, because a
Durable Object can own a connection for longer than a request. Serve the
handshake from an [API route](/docs/api-routes#websockets) and forward it to the
object:

```ts [src/api/ws.ts]
import type { BaseRouteArgs } from "@pracht/core";

export async function GET({ context, request, url }: BaseRouteArgs) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const { CHAT_ROOM } = context.env as { CHAT_ROOM: DurableObjectNamespace };
  const room = url.searchParams.get("room") ?? "lobby";
  return CHAT_ROOM.get(CHAT_ROOM.idFromName(room)).fetch(request);
}
```

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

Pracht returns the `101` exactly as the handler produced it — copying it would
drop the `webSocket` handle, since that property is a Cloudflare extension to
`ResponseInit` rather than part of the fetch standard. Upgrades work in
`pracht dev` too, because workerd serves dev for this adapter.

Cross-origin upgrades are rejected by default: browsers do not apply CORS to
WebSocket, so the check that guards mutations guards handshakes as well.

### Accessing Cloudflare bindings

The `env` object is passed through to your loaders and API routes via the context:

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

Cloudflare Workers itself allows top-level access through
`import { env } from "cloudflare:workers"`, but Pracht graph inspection cannot
provide authoritative bindings. In API and capability modules, read `env.DB`,
`env.MY_KV`, or `exports.*` inside the handler, capability `run()`, or another
request-time function — not during module initialization. Importing `env` is
safe; a top-level property read fails closed with the binding name so a fake
value cannot silently alter inspected security or transport metadata.

### Deploy

```sh
pracht build
npx wrangler deploy
```

---

## Vercel Edge Functions

Deploy using Vercel's Build Output API v3. SSG pages are served from the static file system and SSR/API routes go through the Edge Function. ISG routes get one Serverless Function each — Vercel only supports ISR (`.prerender-config.json`) on serverless, and rejects a deployment that pairs it with an Edge Function.

### Setup

```ts
// vite.config.ts
import { vercelAdapter } from "@pracht/adapter-vercel";
pracht({ adapter: vercelAdapter() })

// package.json
"@pracht/adapter-vercel": "*"
```

Static prerendered routes receive document headers through the generated Build Output `headers` config.

ISG Serverless invocations render on a sanitized request — path only, `Accept: text/html`, no cookies, credentials, query string, or body — because Vercel keys the prerender cache on the path alone and replays the stored response to every visitor. Credential headers on the rendered response (`Set-Cookie`, `Authorization`, secret-shaped `x-*`) are stripped before Vercel stores it.

If `vercelAdapter({ regions: "all" })` is configured, the Edge function remains global while Node ISG functions use the project's default Serverless region. Node functions require concrete region identifiers and cannot use Edge's `all` sentinel.

When using webhook revalidation, `PRACHT_REVALIDATE_TOKEN` must be present **at
build time**. Vercel's `bypassToken` is embedded in each
`.prerender-config.json`; setting the variable only at runtime authenticates
Pracht's webhook but cannot bypass the prerender cache until the app is
rebuilt. Time-only ISR does not require this secret.

### Build output

```
.vercel/
  output/
    config.json    // routes, rewrites, headers
    static/        // SSG pages served from the filesystem
    functions/
      render.func/ // Edge Function for SSR/API routes and webhook bridge
      pricing.func/ // Serverless Function for one ISG route
      pricing.prerender-config.json
```

### Deploy

```sh
pracht build
npx vercel deploy --prebuilt
```

### Preview and generated functions

Vercel has no faithful local production runtime, so `pracht preview` exits with
guidance instead of emulating one. Use `vercel build` to reproduce production
output and `vercel dev` for Vercel's local development environment.

The main Edge Function defaults to
`.vercel/output/functions/render.func`. Use
`vercelAdapter({ functionName: "app" })` if an ISG route would collide with
that name. Runtime ISG routes are Node Serverless Functions because Vercel
does not support native ISR on Edge Functions. Generated entries export
`nodeListener`, built with `createVercelNodeListener(handle)`, so those Node
functions can run the same Web API handler and drain `waitUntil()` work. A
custom Vercel server entry must provide the same export.

---

## Node.js

Run pracht as a standard Node.js HTTP server. The adapter handles static file serving, ISG stale-while-revalidate, request translation, and the generated `dist/server/server.js` entry boots the production server directly.

Prerendered HTML receives document headers from `dist/server/headers-manifest.json`; `dist/server/markdown-manifest.json` records the exact routes with raw Markdown representations.

### Setup

```ts
// vite.config.ts
import { nodeAdapter } from "@pracht/adapter-node";
pracht({ adapter: nodeAdapter() })

// package.json
"@pracht/adapter-node": "*"
```

### Origin, proxy, and body-size options

Pin the public origin in generated Node entries so `request.url` never depends
on an attacker-controlled `Host` header:

```ts [vite.config.ts]
nodeAdapter({
  canonicalOrigin: "https://app.example.com",
  maxBodySize: 10 * 1024 * 1024,
});
```

`maxBodySize` defaults to 1 MiB. Without `canonicalOrigin`, built servers warn
that the URL is Host-derived. Applications with a custom entry can instead
pass `trustProxy: true` to `createNodeRequestHandler()` when they are behind a
trusted reverse proxy that overwrites `Forwarded` or `X-Forwarded-*` headers.
Never enable it on a directly reachable server; `canonicalOrigin` is safer
when the public origin is fixed.

### Deploy

```sh
pracht build
node dist/server/server.js
// Server listening on http://localhost:3000
```

### WebSockets

Node's `http.Server` delivers upgrade requests to its `upgrade` event rather
than to the request handler, so a handshake never reaches pracht. Attach a
WebSocket server to the same HTTP server instead — the generated entry exports
`handler`, and only starts a server of its own when run as the process
entrypoint:

```js
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { handler } from "./dist/server/server.js";

const server = createServer(handler);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Check req.headers.origin yourself — this bypasses pracht entirely, so
  // pracht's same-origin protection does not apply.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(3000);
```

---

## Context Factory

Adapters inject platform-specific values into loaders and API routes via a context factory. With generated entries, point the adapter at a module that exports `createContext`:

```ts [vite.config.ts]
nodeAdapter({ createContextFrom: "/src/server/context.ts" });
cloudflareAdapter({ createContextFrom: "/src/server/context.ts" });
vercelAdapter({ createContextFrom: "/src/server/context.ts" });
```

```ts [src/server/context.ts]
// Node: inject a database pool
export function createContext({ request }: { request: Request }) {
  return {
    db: pool,
    ip: request.headers.get("x-forwarded-for"),
  };
}

// Cloudflare receives { request, env, executionContext }.
// Vercel Edge receives { request, context }. Node ISG provides a
// waitUntil-compatible context, without other Edge-only fields.
```

The context object is available as `args.context` in every loader, middleware, and API route handler.

---

## Writing a Custom Adapter

A custom adapter exports a factory function that returns a `PrachtAdapter` object:

```ts
import type { PrachtAdapter } from "@pracht/vite-plugin";
import { myPlatformGraphStubs, myPlatformVitePlugin } from "my-platform-vite-plugin";

export function myAdapter(): PrachtAdapter {
  return {
    id: "my-platform",
    serverImports:
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return `
export default async function handle(request) {
  return handlePrachtRequest({
    app: resolvedApp,
    registry,
    request,
    apiRoutes,
    clientEntryUrl: clientEntryUrl ?? undefined,
    cssManifest,
    jsManifest,
  });
}
`;
    },
    vitePlugins() {
      return myPlatformVitePlugin({ entry: "virtual:pracht/server" });
    },
    // Graph commands call this hook instead of vitePlugins(). Only return
    // metadata helpers or safe runtime-module stubs; never start a runtime.
    graphVitePlugins() {
      return myPlatformGraphStubs();
    },
  };
}
```

`pracht inspect`, `plan`, `verify`, `report`, `doctor`, and `typegen` run a
short-lived graph-only Vite server. They never load an adapter's regular
`vitePlugins()`. If `graphVitePlugins()` is omitted, they load no
adapter-contributed plugins.

At the runtime level, an adapter also typically needs to:

1. Accept a platform request and convert it to a Web `Request`
2. Check for static assets -- serve files from `dist/client/` with appropriate headers
3. Check for prerendered pages -- serve SSG/ISG HTML (with staleness checking for ISG when the platform supports it)
4. Delegate dynamic requests to `handlePrachtRequest()` from `pracht`
5. Convert the Web `Response` back to the platform's response format
6. Provide a context factory for platform-specific values
7. Export an entry module generator for the Vite plugin

> [!INFO]
> See the source of `@pracht/adapter-cloudflare` or `@pracht/adapter-node` in the monorepo for a concrete reference implementation.
