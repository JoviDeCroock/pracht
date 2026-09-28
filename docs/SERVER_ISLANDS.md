# Server Islands

SSG and ISG documents are rendered once and shared by every visitor, and
everything in them — island props included — is fixed at render time. A
**server island** is a server-rendered component that renders per
request, with the visitor's cookies and the page route's middleware context,
inside an otherwise cached document. The public guide is
`examples/docs/src/routes/docs/server-islands.md` (`/docs/server-islands` on the site).

## Name

"Server island" says what it is — a part of the page with its own rendering
lifetime — and "request-time" says which lifetime. It does not collide with
existing concepts: islands are about *hydration* (client JS), shells are
layout, and `fragment-navigation.ts` already owns URL `#fragments`. Code uses
`serverIsland`/`serverIslands` throughout: `src/server-islands/`, `<pracht-server-island>`,
`/__pracht/server-island`, `serverIslands-*.ts`.

## Authoring Surface

```tsx
// src/server-islands/CartCount.tsx
export async function loader({ context, props }: ServerIslandLoaderArgs) { ... }
export default function CartCount(props: { label: string } & ServerIslandProps) {
  const data = useServerIslandData<typeof loader>();
  ...
}

// any page or shell
<CartCount label="Cart" fallback={<a href="/cart">Cart</a>} />
```

- Every module in `serverIslandsDir` (default `/src/server-islands`) is a server island; the
  default export is the component, `loader` is optional.
- `fallback` is framework-owned and stripped before the component renders.
- Props must be JSON-serializable (the island validator, with server island wording);
  children are rejected.
- Loader data is only rendered, never serialized, so it can be any value.

The surface is deliberately one directory, one hook, two types, and one prop.

## Architecture

### Detection

`virtual:pracht/server` eagerly globs the server islands directory and calls
`registerServerIslandModules()`. Like islands, a Preact `options.vnode` hook retypes
vnodes whose type is a registered server island component to `ServerIslandBoundary`, so call
sites stay plain JSX. The server build splits each server island into its own chunk
(`server-islands/<name>`, the island chunking in `chunk-groups.ts`) so a route's CSS
resolution is not merged into the server entry.

### Render context

`renderServerDocument()` provides a `ServerIslandRenderContext` only when server islands are
registered — apps without server islands do no extra work. Its `mode` is:

- **inline** for `render: "ssr"` documents that do not stream;
- **defer** for everything else (SSG/ISG, streamed SSR, and renders outside a
  page such as error documents).

`ServerIslandBoundary` renders `<pracht-server-island island="/src/server-islands/X.tsx"
props="…" style="display:contents">`:

- **defer** — adds `pending` and renders the fallback as children. The state
  records that a pending placeholder exists.
- **inline** — renders a per-render random token comment as
  `dangerouslySetInnerHTML` and queues the server island (props, fallback, and the
  runtime/island/script contexts it saw).

After `renderToStringAsync()`, `resolveInlineServerIslands()` runs every queued
server island concurrently — loader, then a separate render with the captured
contexts re-provided — and replaces each token. Nested server islands resolve the
same way (depth capped at 8). A failure is reported through `onRouteError`
(`serverIslandFile` set, `describeRouteErrorModule` blames the server island) and the
fallback is rendered instead.

Token substitution was chosen over suspending inside the page render: a thrown
promise under `preact-render-to-string` wraps output in `<!--$s-->` Suspense
markers that full-hydration pages would then try to hydrate, and it serializes
server islands behind each other. Substitution keeps the page render untouched and
the server islands parallel. It does not work for streamed documents, which is why
those defer.

### The endpoint

`handlePrachtRequest()` answers `GET /__pracht/server-island` (base-free path) right
after the request context is built, before API routes, but only when the app
registered at least one server island. In an app without a server islands directory the path
is routed like any other URL. `handleServerIslandRequest()`:

1. requires `x-pracht-server-island: 1` (a custom header a cross-site page cannot send
   without a CORS preflight) and `GET`;
2. looks up `serverIsland` in the registry, parses `props` (≤ 4 KiB, JSON object),
   validates `path` as a same-origin path;
3. strips the deploy base, matches the page path against the route table;
4. builds a page request — the page URL with the server island request's headers and
   signal — and runs the matched route's middleware chain around a terminal
   that runs the loader and renders the server island (with `PrachtRuntimeProvider`
   for the page, and an island capture when the page is `hydration:
   "islands"`);
5. answers with the fragment, or `204` when middleware/the loader answered
   with any other `Response`, or `500` when it threw.

Every server island response is pinned to `Cache-Control: private, no-store` after
middleware runs, carries the default security headers and `x-robots-tag:
noindex`, and is marked `x-pracht-server-island: 1` so the dev server forwards it
without the document HTML transform. When the server island rendered islands on an
islands page, `x-pracht-islands` names the islands bootstrap URL.

### Browser

- **`virtual:pracht/server-islands-client`** (swap script) — a separate client entry,
  built only when the server islands directory exists. `hydration: "none"` and
  `"islands"` documents reference it (with modulepreload for its chunks) only
  when their render emitted a pending placeholder. It imports no Preact: it
  fetches every `pracht-server-island[pending]`, swaps `innerHTML`, removes `pending`,
  and sets `html[data-pracht-server-islands-ready]`. On `x-pracht-islands` it appends
  a module script for the bootstrap (a fresh bootstrap scans the whole
  document; one that already ran hears the bubbling `pracht:server-island` event).
- **Client server island component** — in the client environment the plugin's `load`
  hook replaces each server island module with
  `createClientServerIsland(file)` from `@pracht/core/server-islands-component`, keeping only
  bare stylesheet imports. It renders the element with an empty
  `dangerouslySetInnerHTML`, which Preact neither applies during hydration nor
  re-applies on re-render, so the server markup is an opaque subtree. After
  mount it fills a `pending` server placeholder, leaves inline markup alone,
  and — when mounted by a client navigation (no server `serverIsland` attribute) —
  renders the fallback and fetches. It refetches when its props or the page
  URL change.
- **Islands bootstrap** — gated by the `__PRACHT_SERVER_ISLANDS__` define (true only
  when the server islands directory exists at build time), it listens for
  `pracht:server-island` and hydrates islands inside the swapped server island, marking
  `data-hydrated="pending"` first so a concurrent initial scan cannot hydrate
  the same island twice. With the flag false the bootstrap is byte-identical to
  an app without server islands (`pnpm bench:check`).

## Request Flow — cached page

```
BROWSER                              SERVER / CDN
GET /pricing ─────────────────────►  prerendered HTML (shared, cacheable)
◄── <pracht-server-island pending>fallback</pracht-server-island>
    <script type=module src=server-islands-client.js>
GET /assets/server-islands-client*.js ──►   static
GET /__pracht/server-island?island=…&path=/pricing&props=…
    x-pracht-server-island: 1, Cookie: … ►  match /pricing → route middleware chain
                                      → server island loader(context, props, signal)
                                      → render fragment
◄── 200 text/html, Cache-Control: private, no-store
swap innerHTML, remove `pending`
(islands in the fragment → load the islands bootstrap → hydrate)
```

On an SSR page the server island is part of the one document response.

## Trust Decisions

- **Props are unsigned and untrusted.** Signing (HMAC) was considered and
  rejected. On a cached page the signed value would be computed at build or
  regeneration time and shared by every visitor, so it proves only "some page
  render produced these props" and carries nothing about the visitor; a server island
  still must not authorize from them. Signing would also need a secret
  available at build time and at runtime on every adapter, and client
  navigation on full-hydration pages would have no signature to send. The docs
  instead say plainly: treat props like query parameters.
- **The caller chooses the page path**, therefore which route's middleware runs
  and which `params` the loader sees. Middleware builds `context`; server island
  loaders must authorize from `context` themselves, like API routes. Concretely:
  a server island rendered only on an `admin`-gated page, whose loader skips its own
  check because "the page is gated", answers anonymous callers who name any
  ungated path (verified against a Node build). Server island file paths are not
  secret either: a full-hydration route's public client chunk contains
  `createClientServerIsland("/src/server-islands/X.tsx")`. The same goes for `params`: a
  loader that trusts `params.org` because the hosting route's middleware checked
  membership can be called under any other route with an `:org` segment.
  A build-time route↔server island binding (from the module graph: the endpoint only
  runs a server island under routes whose route or shell module imports it) would close
  this class; it was left out to keep dev and prod identical and the surface
  small. The site page states the rule as "props are untrusted input; authorize
  from `context` inside the loader".
- **GET-only, custom header required.** A top-level navigation or a cross-site
  `fetch` cannot reach a server island, so the endpoint is not a reflected-content or
  CSRF vector. Server island loaders should still be side-effect free.

## Caching and Adapters

The endpoint is dispatched by the core runtime, so every server adapter serves
it with no adapter code. Server island responses are `private, no-store`. Adapters
only cache ISG pages by prerendered path (Node, Netlify, Vercel) or by ISG
route match (Cloudflare Workers Caching); `findCacheableIsgRoute()` excludes
the server island endpoint explicitly so a catch-all ISG route cannot make it
edge-cacheable. ISG regeneration renders the document in defer mode, so a
regenerated page never contains a visitor's server island.

The static adapter has no server: `ServerIslandBoundary` throws while prerendering
for a static target, failing the build with a pointer to islands.

## CSP

The swap script is an external module, never inline, so shared documents need
no nonce (`script-src 'self'`, `connect-src 'self'`). See [CSP.md](CSP.md).

## Cost

- Apps without a server islands directory: 0 bytes (no entry, flag folded, bench
  baseline unchanged). Server work: one `hasRegisteredServerIslands()` check per
  document.
- Pages that render no pending server island: 0 bytes.
- The swap script on a `hydration: "none"` page: ~2.0 KB raw / ~1.3 KB gzip
  across its entry, its shared chunk, the deploy-base helper, and the shared
  constants (measured on `examples/islands`), all modulepreloaded.

## Limitations

- `pracht build --analyze` does not attribute the swap script to routes.
- Islands inside a server island stay static HTML on full-hydration pages.
- `<Script strategy="beforeHydration">` inside a server island rendered by the
  endpoint has no document head to land in.
- A server island module must live in the server islands directory; helper modules there are
  treated as server islands too (put helpers elsewhere).
- Render server islands from pages and shells, not from inside islands: an island's
  client code would get the placeholder component, and a pending server island inside
  an island would be filled twice (swap script and placeholder).
- A server island's data is not part of route-state JSON; on full-hydration pages a
  client navigation mounts the server island fresh and fetches it.
- A server island refetches only when its props or the page URL change, not after
  `useRevalidate()` or a `<Form>` submission, so a cart count stays stale
  until the next navigation.
- Server islands in the shell of a not-found or error document never fill: the
  endpoint finds no route for that path and the fallback stays.
- The endpoint pins `private, no-store` on server island responses, but an SSR page
  that renders a server island inline is the app's own response. An app that sets a
  public `Cache-Control` on such a page caches one visitor's server island for all.
- On the static adapter, a server island inside an `spa` route is only reached in the
  browser, so the build cannot reject it. The fetch 404s and the fallback
  stays, unless the host rewrites unknown URLs to an SPA `fallback` document
  with status 200: the swap then renders that document inside the server island,
  because the browser half checks only the status, not the
  `x-pracht-server-island: 1` response marker.
- On a client-navigation mount, the fallback is rendered into the server island
  element as its own Preact root, so it does not see router context.

## Tests

- `packages/framework/test/server-islands.test.ts` — detection, placeholder and inline
  rendering, fallback on failure, islands capture, and the endpoint (middleware,
  loader args, no-store, 204/4xx/500 paths, islands header).
- `packages/framework/test/server-islands-client.test.ts` — the swap script and the
  client server island component under jsdom (hydration keeps markup, pending fill,
  client-navigation mount).
- `e2e/server-islands-dev.test.ts` (islands project) and the server islands section of
  `e2e/islands-build.test.ts` — cookie-dependent content on an SSG page whose
  HTML is identical per visitor, inline SSR, islands inside a server island, full
  hydration, and failure fallback against the dev server and a Node build.
