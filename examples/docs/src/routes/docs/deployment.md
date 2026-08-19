---
title: Deployment
lead: pracht apps deploy anywhere via platform adapters. Each adapter handles request conversion, asset serving, and the runtime's supported ISG revalidation strategy.
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
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { nodeAdapter } from "@pracht/adapter-node";

export default defineConfig({
  plugins: [
    pracht({
      adapter: nodeAdapter({
        canonicalOrigin: "https://app.example.com",
      }),
    }),
  ],
});
```

`canonicalOrigin` prevents Host-derived request URLs in production. The Node
adapter also accepts `maxBodySize`; custom entries can pass `trustProxy: true`
to `createNodeRequestHandler()` only when a trusted reverse proxy overwrites
forwarded headers.

Responses are compressed by default: the adapter negotiates `Accept-Encoding`
(highest q-value wins, including an explicitly higher `identity` preference,
with brotli preferred on ties) and streams dynamic HTML, route-state JSON, and
other compressible text types through `node:zlib`, while static assets and ISG
snapshots are compressed once per file version and served from an in-memory
LRU; successful ISG writes use an atomic file replacement whose filesystem
identity stays private to local cache keys, while content-derived public
validators remain stable across sibling handlers and deployment replicas and
local cache generations discard old compressed bytes. Response reads stay bound to the
same open file version that supplied their size and validator, so concurrent
replacement cannot mix bytes with stale metadata or bypass the cold-work byte
budget. This remains correct when coarse filesystem timestamps do not change
and a request reaches a restarted or sibling worker. Date-only validation is
conservatively bypassed for mutable ISG snapshots while compression is enabled.
Buffered cold work is byte- and concurrency-bounded, with overflow falling back
to streaming compression. Static WebAssembly is served as
`application/wasm` and follows the same compression path. Compressible
responses carry `Vary: Accept-Encoding`, including on application-generated
`304` responses; encoded variants get their own collision-resistant weak ETag,
with dynamic `If-None-Match` / `If-Modified-Since` validation performed after
representation selection so identity and encoded validators cannot cross.
Range requests retain their original validators because `206` responses are
never transformed. `HEAD` advertises the same negotiated metadata as `GET`,
including buffered compressed lengths, and
already-encoded, `no-transform`, Range, integrity-protected (`Content-Digest`,
`Repr-Digest`, legacy
`Digest`/`Content-MD5`), and sub-1 KiB responses whose size is known are left
alone. If a reverse proxy or CDN in front of the server already compresses
responses, turn it off:

```ts [vite.config.ts]
nodeAdapter({ compression: false });
```

```sh
# Build and run
pracht build
pracht preview
# or: node dist/server/server.js
```

---

## Cloudflare Workers

Deploys as a Cloudflare Worker with static assets served via the `ASSETS` binding.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
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
For named primitives such as Durable Object and Workflow classes, re-export
them from a dedicated module and pass that module through
`workerExportsFrom`. Queue, scheduled, and email consumers live on the
Worker's default export; provide those separately through
`workerHandlersFrom`. See the [adapter reference](/docs/adapters#exporting-bindings-and-event-handlers) for both examples.

For a production-style local smoke test, run `pracht preview`. It delegates to
Wrangler, so put local-only Worker secrets in a gitignored `.dev.vars` file:

```dotenv [.dev.vars]
PRACHT_CONFIRMATION_SECRET=local-only-secret
```

A host-prefixed environment variable is not automatically a Worker binding.
Also note that a configured custom-domain route can make the Worker see that
domain in `request.url` even while preview listens on localhost; Web Bot Auth
clients must sign the effective `@authority`.

Cloudflare supports runtime ISG through its Cache API, or through opt-in
Workers Caching with `cloudflareAdapter({ cache: true })`. Canonicalize query
strings and trailing slashes before enabling shared edge caching.

---

## Vercel

Deploys as a Vercel Edge Function with static assets served from the CDN.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
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

SSG pages are static, SSR/API routes use the Edge Function, and ISG routes use
Vercel's native ISR on Node Serverless Functions. When using webhook
revalidation, set `PRACHT_REVALIDATE_TOKEN` during the build so the same token
is embedded in Vercel's prerender configuration; time-only ISR does not require
it. Use `functionName` to rename the default `render` Edge Function if it would
collide with an ISG route.

`pracht preview` deliberately does not emulate Vercel production. Use
`vercel build` to reproduce the Build Output and `vercel dev` for Vercel's
local development runtime.

---

## Netlify

Deploys through a fetch-style Netlify Functions v2 handler with SSG documents
and ISG responses stored in Netlify's durable CDN cache.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { netlifyAdapter } from "@pracht/adapter-netlify";

export default defineConfig({
  plugins: [pracht({ adapter: netlifyAdapter() })],
});
```

```toml [netlify.toml]
[build]
  command = "pnpm build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

```sh
pracht build && netlify dev
netlify deploy --build --prod
```

The generated function preserves Markdown negotiation and client route-state
requests while hashed assets bypass it. Time-based ISG uses durable
stale-while-revalidate caching; authenticated webhook revalidation purges
per-path cache tags. Use `netlifyAdapter({ excludedPath: [...] })` for extra
static prefixes, but do not exclude page URLs. Prefix-shaped exclusions also
stay outside the generated function bundle.

`pracht preview` deliberately does not emulate Netlify's Functions and CDN
behavior; build the generated function before using `netlify dev` for the
platform-shaped local runtime.

---

## Custom Context

Generated adapter entries can import a context factory that enriches the context passed to loaders, API routes, and middleware:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
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
