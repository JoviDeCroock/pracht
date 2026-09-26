# Request-time Regions

SSG and ISG documents are rendered once and shared by every visitor, and
everything in them — island props included — is fixed at render time. A
**request-time region** is a server-rendered component that renders per
request, with the visitor's cookies and the page route's middleware context,
inside an otherwise cached document. The public guide is
`examples/docs/src/routes/docs/regions.md` (`/docs/regions` on the site).

## Name

"Region" says what it is — a part of the page with its own rendering
lifetime — and "request-time" says which lifetime. It does not collide with
existing concepts: islands are about *hydration* (client JS), shells are
layout, and `fragment-navigation.ts` already owns URL `#fragments`. Code uses
`region`/`regions` throughout: `src/regions/`, `<pracht-region>`,
`/__pracht/region`, `regions-*.ts`.

## Authoring Surface

```tsx
// src/regions/CartCount.tsx
export async function loader({ context, props }: RegionLoaderArgs) { ... }
export default function CartCount(props: { label: string } & RegionProps) {
  const data = useRegionData<typeof loader>();
  ...
}

// any page or shell
<CartCount label="Cart" fallback={<a href="/cart">Cart</a>} />
```

- Every module in `regionsDir` (default `/src/regions`) is a region; the
  default export is the component, `loader` is optional.
- `fallback` is framework-owned and stripped before the component renders.
- Props must be JSON-serializable (the island validator, with region wording);
  children are rejected.
- Loader data is only rendered, never serialized, so it can be any value.

The surface is deliberately one directory, one hook, two types, and one prop.

## Architecture

### Detection

`virtual:pracht/server` eagerly globs the regions directory and calls
`registerServerRegions()`. Like islands, a Preact `options.vnode` hook retypes
vnodes whose type is a registered region component to `RegionBoundary`, so call
sites stay plain JSX. The server build splits each region into its own chunk
(`regions/<name>`, the island chunking in `chunk-groups.ts`) so a route's CSS
resolution is not merged into the server entry.

### Render context

`renderServerDocument()` provides a `RegionRenderContext` only when regions are
registered — apps without regions do no extra work. Its `mode` is:

- **inline** for `render: "ssr"` documents that do not stream;
- **defer** for everything else (SSG/ISG, streamed SSR, and renders outside a
  page such as error documents).

`RegionBoundary` renders `<pracht-region region="/src/regions/X.tsx"
props="…" style="display:contents">`:

- **defer** — adds `pending` and renders the fallback as children. The state
  records that a pending placeholder exists.
- **inline** — renders a per-render random token comment as
  `dangerouslySetInnerHTML` and queues the region (props, fallback, and the
  runtime/island/script contexts it saw).

After `renderToStringAsync()`, `resolveInlineRegions()` runs every queued
region concurrently — loader, then a separate render with the captured
contexts re-provided — and replaces each token. Nested regions resolve the
same way (depth capped at 8). A failure is reported through `onRouteError`
(`regionFile` set, `describeRouteErrorModule` blames the region) and the
fallback is rendered instead.

Token substitution was chosen over suspending inside the page render: a thrown
promise under `preact-render-to-string` wraps output in `<!--$s-->` Suspense
markers that full-hydration pages would then try to hydrate, and it serializes
regions behind each other. Substitution keeps the page render untouched and
the regions parallel. It does not work for streamed documents, which is why
those defer.

### The endpoint

`handlePrachtRequest()` answers `GET /__pracht/region` (base-free path) right
after the request context is built, before API routes. `handleRegionRequest()`:

1. requires `x-pracht-region: 1` (a custom header a cross-site page cannot send
   without a CORS preflight) and `GET`;
2. looks up `region` in the registry, parses `props` (≤ 4 KiB, JSON object),
   validates `path` as a same-origin path;
3. strips the deploy base, matches the page path against the route table;
4. builds a page request — the page URL with the region request's headers and
   signal — and runs the matched route's middleware chain around a terminal
   that runs the loader and renders the region (with `PrachtRuntimeProvider`
   for the page, and an island capture when the page is `hydration:
   "islands"`);
5. answers with the fragment, or `204` when middleware/the loader answered
   with any other `Response`, or `500` when it threw.

Every region response is pinned to `Cache-Control: private, no-store` after
middleware runs, carries the default security headers and `x-robots-tag:
noindex`, and is marked `x-pracht-region: 1` so the dev server forwards it
without the document HTML transform. When the region rendered islands on an
islands page, `x-pracht-islands` names the islands bootstrap URL.

### Browser

- **`virtual:pracht/regions-client`** (swap script) — a separate client entry,
  built only when the regions directory exists. `hydration: "none"` and
  `"islands"` documents reference it (with modulepreload for its chunks) only
  when their render emitted a pending placeholder. It imports no Preact: it
  fetches every `pracht-region[pending]`, swaps `innerHTML`, removes `pending`,
  and sets `html[data-pracht-regions-ready]`. On `x-pracht-islands` it appends
  a module script for the bootstrap (a fresh bootstrap scans the whole
  document; one that already ran hears the bubbling `pracht:region` event).
- **Client region component** — in the client environment the plugin's `load`
  hook replaces each region module with
  `createClientRegion(file)` from `@pracht/core/regions-component`, keeping only
  bare stylesheet imports. It renders the element with an empty
  `dangerouslySetInnerHTML`, which Preact neither applies during hydration nor
  re-applies on re-render, so the server markup is an opaque subtree. After
  mount it fills a `pending` server placeholder, leaves inline markup alone,
  and — when mounted by a client navigation (no server `region` attribute) —
  renders the fallback and fetches. It refetches when its props or the page
  URL change.
- **Islands bootstrap** — gated by the `__PRACHT_REGIONS__` define (true only
  when the regions directory exists at build time), it listens for
  `pracht:region` and hydrates islands inside the swapped region, marking
  `data-hydrated="pending"` first so a concurrent initial scan cannot hydrate
  the same island twice. With the flag false the bootstrap is byte-identical to
  an app without regions (`pnpm bench:check`).

## Request Flow — cached page

```
BROWSER                              SERVER / CDN
GET /pricing ─────────────────────►  prerendered HTML (shared, cacheable)
◄── <pracht-region pending>fallback</pracht-region>
    <script type=module src=regions-client.js>
GET /assets/regions-client*.js ──►   static
GET /__pracht/region?region=…&path=/pricing&props=…
    x-pracht-region: 1, Cookie: … ►  match /pricing → route middleware chain
                                      → region loader(context, props, signal)
                                      → render fragment
◄── 200 text/html, Cache-Control: private, no-store
swap innerHTML, remove `pending`
(islands in the fragment → load the islands bootstrap → hydrate)
```

On an SSR page the region is part of the one document response.

## Trust Decisions

- **Props are unsigned and untrusted.** Signing (HMAC) was considered and
  rejected. On a cached page the signed value would be computed at build or
  regeneration time and shared by every visitor, so it proves only "some page
  render produced these props" and carries nothing about the visitor; a region
  still must not authorize from them. Signing would also need a secret
  available at build time and at runtime on every adapter, and client
  navigation on full-hydration pages would have no signature to send. The docs
  instead say plainly: treat props like query parameters.
- **The caller chooses the page path**, therefore which route's middleware runs.
  Middleware builds `context`; region loaders must authorize from `context`
  themselves, like API routes. A build-time route↔region binding (from the
  module graph) could narrow this later; it was left out to keep dev and prod
  identical and the surface small.
- **GET-only, custom header required.** A top-level navigation or a cross-site
  `fetch` cannot reach a region, so the endpoint is not a reflected-content or
  CSRF vector. Region loaders should still be side-effect free.

## Caching and Adapters

The endpoint is dispatched by the core runtime, so every server adapter serves
it with no adapter code. Region responses are `private, no-store`. Adapters
only cache ISG pages by prerendered path (Node, Netlify, Vercel) or by ISG
route match (Cloudflare Workers Caching); `findCacheableIsgRoute()` excludes
the region endpoint explicitly so a catch-all ISG route cannot make it
edge-cacheable. ISG regeneration renders the document in defer mode, so a
regenerated page never contains a visitor's region.

The static adapter has no server: `RegionBoundary` throws while prerendering
for a static target, failing the build with a pointer to islands.

## CSP

The swap script is an external module, never inline, so shared documents need
no nonce (`script-src 'self'`, `connect-src 'self'`). See [CSP.md](CSP.md).

## Cost

- Apps without a regions directory: 0 bytes (no entry, flag folded, bench
  baseline unchanged). Server work: one `hasRegisteredRegions()` check per
  document.
- Pages that render no pending region: 0 bytes.
- The swap script on a `hydration: "none"` page: ~2.0 KB raw / ~1.3 KB gzip
  across its entry, its shared chunk, the deploy-base helper, and the shared
  constants (measured on `examples/islands`), all modulepreloaded.

## Limitations

- `pracht build --analyze` does not attribute the swap script to routes.
- Islands inside a region stay static HTML on full-hydration pages.
- `<Script strategy="beforeHydration">` inside a region rendered by the
  endpoint has no document head to land in.
- A region module must live in the regions directory; helper modules there are
  treated as regions too (put helpers elsewhere).
- Render regions from pages and shells, not from inside islands: an island's
  client code would get the placeholder component, and a pending region inside
  an island would be filled twice (swap script and placeholder).
- A region's data is not part of route-state JSON; on full-hydration pages a
  client navigation mounts the region fresh and fetches it.

## Tests

- `packages/framework/test/regions.test.ts` — detection, placeholder and inline
  rendering, fallback on failure, islands capture, and the endpoint (middleware,
  loader args, no-store, 204/4xx/500 paths, islands header).
- `packages/framework/test/regions-client.test.ts` — the swap script and the
  client region component under jsdom (hydration keeps markup, pending fill,
  client-navigation mount).
- `e2e/regions-dev.test.ts` (islands project) and the regions section of
  `e2e/islands-build.test.ts` — cookie-dependent content on an SSG page whose
  HTML is identical per visitor, inline SSR, islands inside a region, full
  hydration, and failure fallback against the dev server and a Node build.
