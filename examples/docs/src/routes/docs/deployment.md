---
title: Deployment
lead: pracht apps deploy anywhere via platform adapters. Each adapter handles request conversion, asset serving, and the runtime's supported ISG revalidation strategy.
breadcrumb: Deployment
prev:
  href: /docs/upgrading
  title: Upgrading
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
forwarded headers. When the proxy strips Vite's deploy base from the forwarded
path, set `nodeAdapter({ basePathStripped: true })` so a matching first route
segment is not stripped a second time.

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
Buffered cold work is byte- and concurrency-bounded, including content-derived
validator hashing; same-snapshot requests share one hash, and an overloaded
response omits its ETag rather than queuing an unbounded whole-file read.
Overflowed compression jobs fall back to streaming. Static WebAssembly is
served as `application/wasm` and follows the same compression path.
Compressible responses carry `Vary: Accept-Encoding`, including on
application-generated `304` responses; encoded variants get their own
collision-resistant weak ETag, with encoded dynamic requests performing
`If-Match` / `If-None-Match` / `If-Modified-Since` validation after
representation selection so identity and encoded validators cannot cross.
`If-Match` uses strong comparison and preserves its precedence over
`If-Unmodified-Since`. Requests carrying `Range` retain their original
validators and remain identity-encoded even when the application returns a full
`200`; `206` responses are likewise never transformed. `HEAD` advertises the
same negotiated metadata as `GET`, including buffered compressed lengths, and
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

## Static hosts

Apps whose routes are all `ssg` (or loaderless, full-hydration `spa`), with no request
middleware, API routes, or network-exposed capabilities, can skip servers
entirely with `@pracht/adapter-static` — GitHub Pages, S3, nginx, Netlify, any
file host.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [pracht({ adapter: staticAdapter() })],
});
```

```sh
# Build and preview
pracht build      # dist/client/ is the whole deployment
pracht preview
```

The build serializes each full-hydration SSG route whose loader or route/shell
`head()` metadata participates in navigation to collision-safe bounded opaque
`.json` files under `_pracht/state/` so client-side navigation works without a
server, emits the `notFound` page as `404.html`, and — with
`staticAdapter({ fallback: "200.html" })` — an SPA fallback document for hosts
that can rewrite unmatched URLs. Explicitly loaderless and headless routes
fetch no Pracht state; loaderless routes with head metadata fetch static state
for font-head fragments and can still call external APIs directly from the
browser. Static `notFound` pages
must use full hydration so they can adopt the requested URL; the SPA fallback
reuses their build-time loader data when it renders an unknown URL. Anything that needs a
runtime server (`ssr` or `isg` routes, SPA loaders, middleware, API routes,
exposed capabilities) fails the build with an error naming the offenders. See
the [Adapters Reference](/docs/adapters) for host configuration details.

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

---

## Sub-Path Deploys

Set Vite's `base` to serve the app under a path rather than an origin root — a
GitHub Pages *project* site (`https://user.github.io/my-project/`), an S3 key
prefix, a reverse-proxy mount point:

```ts [vite.config.ts]
export default defineConfig({
  base: "/my-project/",
  plugins: [pracht({ adapter: nodeAdapter() })],
});
```

The base is where the deploy is *served*, not part of the output tree.
`dist/client/` still contains `about/index.html`, and the whole directory is
uploaded to the sub-path. What changes is every URL the build emits: `<script
src>`, CSS and modulepreload links, `/_pracht/state/…` fetches, `llms.txt`
links, the default `@pracht/image` optimization endpoint, the generated OpenAPI
document and UI, and every href produced by `<Link route>`, `href()`,
`useNavigate()`, and `prefetch()`.

Route paths in the manifest stay base-free — the router strips the base before
matching — while `useLocation()` reports the URL as the visitor sees it, base
included.

`pracht dev` and `pracht preview` both serve the app under the same base, so
local checks exercise the deployed shape. A bare `/my-project` is redirected to
`/my-project/`, preserving the query. That trailing slash matters for the root
document: without it, a relative link like `assets/app.js` would resolve at the
origin root.

### Hand-written links do not get the base

`<a href="/about">` means the origin root in HTML, and pracht does not rewrite
it — the same rule as Next's `basePath` and SvelteKit's `base`. Use
`<Link route="about">` or `href("about")` for internal navigation and the base
is applied for you. A same-origin link that falls outside the base is handed to
the browser rather than matched as a route.

For the paths you do write by hand — a root-absolute `<a href>`, a `fetch()` to
your own endpoint, an asset URL built at runtime — three helpers move a path
across the base:

```ts
import { PRACHT_BASE, withBase, stripBase } from "@pracht/core";

PRACHT_BASE; // "/my-project/" — always leading and trailing slashes, "/" by default
withBase("/about"); // "/my-project/about"   route path → URL path
stripBase("/my-project/about"); // "/about"  URL path → route path
stripBase("/elsewhere"); // null — outside the base, so not this app
```

At the default base of `/` both functions are the identity, so code written this
way costs nothing until the app moves under a sub-path.

### Base values that are build errors

| Value | Why it fails |
| --- | --- |
| `https://cdn.example.com/`, `//cdn…` | A CDN base only relocates assets; documents and the route-state tree stay at the origin root |
| `"./"`, `""` | A document-relative base makes nested pages resolve assets beneath their own directory |
| Repeated slashes, malformed percent escapes, segments decoding to `/`, `\`, `.`, `..`, NUL, or a control character | Unsafe URL segments |

Use `/` or a root-absolute path such as `/my-project/`. Equivalent
percent-escape spellings are accepted and matched canonically at runtime.

### Behind a proxy that strips the base

The Node adapter assumes the deploy base is still present on the forwarded
path, and maps base-prefixed asset, document, and ISG URLs onto the base-free
paths in the build output. When a trusted proxy removes the base before
forwarding, tell the adapter so it stops looking for it — and note that the
proxy then owns the trailing-slash redirect:

```ts [vite.config.ts]
pracht({ adapter: nodeAdapter({ basePathStripped: true }) });
```

This has to be declared rather than detected: a forwarded `/my-project/about`
is ambiguous by inspection — it could be a retained base followed by `/about`,
or a stripped-base request for a route whose own path is `/my-project/about`.

Cloudflare, Netlify, and Vercel deployments always retain the base and apply the
redirect themselves. Custom serverful adapters get it from
`handlePrachtRequest()`.

### Static hosts

The [static adapter](/docs/adapters) requires `/` or a root-absolute base for
the reasons in the table above. `pracht preview` answers anything outside the
base with a 404, matching what a correctly configured host does.
