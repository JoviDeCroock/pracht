# Server Islands

SSG and ISG documents are rendered once and shared by every visitor, and
everything in them — island props included — is fixed at render time. A
**server island** is a server-rendered component that renders per request,
with the visitor's cookies and the page route's middleware context, inside an
otherwise cached document. The public guide is
`examples/docs/src/routes/docs/server-islands.md` (`/docs/server-islands` on
the site).

## Name

The feature shipped in review as "request-time regions" and was renamed before
release. "Region" already meant three other things next to it: deployment
regions (`vercelAdapter({ regions })`, and the Cloudflare, Netlify, and Fly
equivalents), the region subtag of a locale in `@pracht/i18n`, and ARIA
landmark regions in the markup the element sits in. The docs feed `llms.txt`,
so a coding agent searching for "regions" would have found all four.

A server island is a server-rendered component deferred out of a cached page
behind a fallback, fetched per request. The name pairs with pracht's own
islands, which hydrate in the browser: an island is interactive client code on
a server-rendered page, and a server island is per-request server output on a
cached page. Code uses
`serverIsland`/`serverIslands` throughout: `src/server-islands/`,
`<pracht-server-island>`, `/__pracht/server-island`, `server-islands-*.ts`.

## Authoring Surface

```tsx
// src/server-islands/CartCount.tsx
export async function loader({ context, props }: ServerIslandLoaderArgs) { ... }
export default function CartCount(props: { label: string } & ServerIslandProps) {
  const data = useServerIslandData<typeof loader>();
  ...
}

// any page or shell
export const serverIslands = [CartCount];
<CartCount label="Cart" fallback={<a href="/cart">Cart</a>} />
```

- Every module in `serverIslandsDir` (default `/src/server-islands`) is a
  server island; the default export is the component, `loader` is optional.
- `fallback` is framework-owned and stripped before the component renders.
- Props must be JSON-serializable (the island validator, with server island
  wording); children are rejected.
- Loader data is only rendered, never serialized, so it can be any value.
- A route or shell that renders a server island lists it in its
  `serverIslands` export (see "Route binding").

The surface is one directory, one hook, two types, one prop, and one route
export.

## Architecture

### Detection

`virtual:pracht/server` eagerly globs the server islands directory and calls
`registerServerIslandModules()`. Like islands, a Preact `options.vnode` hook
retypes vnodes whose type is a registered server island to
`ServerIslandBoundary`, so call sites stay plain JSX. The server build splits
each server island into its own chunk (`server-islands/<name>`, the island
chunking in `chunk-groups.ts`) so a route's CSS resolution is not merged into
the server entry.

### Render context

`renderServerDocument()` provides a `ServerIslandRenderContext` only when
server islands are registered — apps without them do no extra work. Its `mode`
is:

- **inline** for `render: "ssr"` documents that do not stream;
- **defer** for everything else (SSG/ISG, streamed SSR, and renders outside a
  page such as error documents).

`ServerIslandBoundary` renders `<pracht-server-island
island="/src/server-islands/X.tsx" props="…" style="display:contents">`:

- **defer** — adds `pending` and renders the fallback as children. The state
  records that a pending placeholder exists.
- **inline** — renders a per-render random token comment as
  `dangerouslySetInnerHTML` and queues the server island (props, fallback, and
  the runtime/island/script contexts it saw).

After `renderToStringAsync()`, `resolveInlineServerIslands()` runs every queued
server island concurrently — loader, then a separate render with the captured
contexts re-provided — and replaces each token. The token carries 72 random
bits per render, so page content (loader data included) cannot contain it.
Nested server islands resolve the same way (depth capped at 8). A failure is
reported through `onRouteError` (`serverIslandFile` set,
`describeRouteErrorModule` blames the server island) and the fallback is
rendered instead.

Token substitution was chosen over suspending inside the page render: a thrown
promise under `preact-render-to-string` wraps output in `<!--$s-->` Suspense
markers that full-hydration pages would then try to hydrate, and it serializes
server islands behind each other. Substitution keeps the page render untouched
and the server islands parallel. It does not work for streamed documents, which
is why those defer.

### The endpoint

`handlePrachtRequest()` answers `GET /__pracht/server-island` (base-free path)
right after the request context is built, before API routes, but only when the
app registered at least one server island. In an app without a server islands
directory the path is routed like any other URL. `handleServerIslandRequest()`:

1. requires `x-pracht-server-island: 1` (a custom header a cross-site page
   cannot send without a CORS preflight) and `GET`;
2. parses `props` (≤ 4 KiB, JSON object) and validates `path` as a same-origin
   path;
3. strips the deploy base and matches the page path against the route table;
4. checks the route binding (below): the `island` parameter must name a
   registered server island that the matched route or its shell lists in
   `serverIslands`;
5. builds a page request — the page URL with the request's headers and signal —
   and runs the matched route's middleware chain around a terminal that runs
   the loader and renders the server island (with `PrachtRuntimeProvider` for
   the page, and an island capture when the page is `hydration: "islands"`);
6. answers with the fragment, or `204` when middleware/the loader answered with
   any other `Response`, or `500` when it threw.

Every response is pinned to `Cache-Control: private, no-store` after middleware
runs, and carries the default security headers and `x-robots-tag: noindex`. A
fragment is marked `x-pracht-server-island: 1`, which is what the browser half
checks before swapping it in and what the dev server reads to forward it
without the document HTML transform. When the server island rendered islands on
an islands page, `x-pracht-islands` names the islands bootstrap URL.

## Route binding

This is the security boundary of the endpoint. Read it before changing
`declaredServerIslands()` or the declaration check in `ServerIslandBoundary`
(`server-islands-server.ts`).

### The problem it closes

The endpoint is a public `GET`. The caller names the page `path`, which decides
the route whose middleware runs and whose `params` the loader sees. Without a
binding, any server island could run under any route. A server island rendered
only on an `admin`-gated page, whose loader relied on that gate, answered
anonymous callers who named an ungated path such as `/static`. A loader that
trusted `params.org` because its page's middleware checked org membership
answered under `/invite/:org`, which has the same param and no check. Server
island file paths are not secret: they are in the page markup and in the public
client chunk of every full-hydration route that renders one.

### The rule

Route and shell modules list the server islands they render:

```tsx
import CartCount from "../server-islands/CartCount.tsx";
export const serverIslands = [CartCount];
```

The endpoint runs server island R for page path P only when R's component is
in the `serverIslands` export of **the route module P matches** or of **that
route's shell module**, and R's file is the one registered for that component.
`registerServerIslandModules()` rejects two files sharing one default export:
lists hold components while the endpoint runs the requested file's loader, so
a shared component would let an unlisted file's loader run under a route that
lists its twin. The generated server module registers with `replace: true`, so
a server island file removed in dev stops answering. Both modules are loaded through the registry exactly as
a page render loads them (`resolveRegistryModule()`), and the check compares
component identity with the registered server island, so it holds the same way
in dev and in a build with no build-time analysis.

Consequence: the middleware that runs and the params the loader sees are
exactly the ones P's own page runs and sees. A server island is never more
reachable than the page that lists it. If P's middleware gates, the gate
applies; if P is public, R is public.

The list is enforced from both sides. A server document render whose route and
shell do not list a server island it renders directly (`depth === 0` in the
render state) throws, naming the server island and the export to add it to, so
on server-rendered pages a list cannot fall behind the JSX. Renders that never
happen on the server (`spa` route components, an SPA shell's `Loading`, error
documents) carry no render state and are not checked; there the endpoint's 404
leaves the fallback, and the dev client logs a warning. A server island
rendered inside another one resolves inline with its parent, in the page render
or in the endpoint, and never reaches the endpoint alone, so it needs no
listing. The client module transform strips `serverIslands` from browser route
and shell modules with the other server-only exports.

What the binding does **not** do:

- It does not make props trustworthy. Props are caller-controlled whatever the
  route (see "Trust Decisions").
- It does not follow render-time conditions. A page that renders
  `{isAdmin && <AdminStats />}` behind a loader check, not middleware, still
  lists `AdminStats`, and the endpoint runs it for anyone who gets through that
  page's middleware. Gates that must protect a server island belong in
  middleware or in its own loader.
- A list may name a server island the page never renders. That widens the
  endpoint to it under this route's middleware; it is the author's explicit
  choice, visible in the route module.

### Failing closed

- A route or shell without the export, or with a non-array one, lists nothing,
  and every server island request for it gets the 404.
- A route or shell module that fails to load answers `500`, reported through
  `onRouteError`, before the server island is looked up.
- An unknown server island and an unlisted one get the same `404 Unknown server
  island`, from the same point, after `props` and `path` were validated for
  both, so neither the status nor the order of checks tells a caller which
  server islands exist. The route and shell modules are loaded before that
  check whatever the `island` parameter says.

An earlier revision inferred the binding from the static import graph (Rollup's
at build time, Vite's per request in dev, handed to the runtime in a dev-only
header). Every review round found a graph shape it got wrong (barrels, shared
modules), and keeping dev and build in agreement took a fixture test of its own.
The explicit list replaced it.

## Browser

- **`virtual:pracht/server-islands-client`** (swap script) — a separate client
  entry, built only when the server islands directory exists. `hydration:
  "none"` and `"islands"` documents reference it (with modulepreload for its
  chunks) only when their render emitted a pending placeholder. It imports no
  Preact: it fetches every `pracht-server-island[pending]`, swaps `innerHTML`
  only for a 200 carrying `x-pracht-server-island: 1` (a static host's SPA
  fallback document is also a 200), removes `pending`, and sets
  `html[data-pracht-server-islands-ready]` (the client component sets it too,
  whenever its last fetch in flight settles). On `x-pracht-islands` it appends a
  module script for the bootstrap (a fresh bootstrap scans the whole document;
  one that already ran hears the bubbling `pracht:server-island` event). It
  runs the same pass again on the Navigation API's `navigatesuccess`, so a
  same-document navigation that swaps in a page with pending server islands
  fills them without loading the module again (with `client.islandsNavigation`,
  a page whose module scripts the document has not run is a full load, so the
  swap script is already running whenever a swapped-in page needs it). It runs
  the pass once more on `pracht:server-islands-scan`, which the islands
  bootstrap dispatches from a slot it has just moved children into: unplaced
  island children ship in an inert `<template pracht-slot>`, so their pending
  server islands are invisible to `querySelectorAll` until then. Each element
  is fetched once: one that answered 204 keeps `pending` but is not fetched
  again, and a server island inside an island that a swap carried over keeps
  the HTML it already has (the incoming copy is dropped with the placeholder).
- **Client server island component** — in the client environment the plugin's
  `load` hook replaces each server island module with
  `createClientServerIsland(file)` from `@pracht/core/server-islands-component`,
  keeping only bare stylesheet imports. It renders the element with an empty
  `dangerouslySetInnerHTML`, which Preact neither applies during hydration nor
  re-applies on re-render, so the server markup is an opaque subtree. After
  mount it fills a `pending` server placeholder, leaves inline markup alone,
  and — when mounted by a client navigation (no server `island` attribute) —
  renders the fallback and fetches. It refetches when its props or the page URL
  change, and on `pracht:server-islands-refresh`.
- **Refresh.** `revalidateRouteData()` (behind `useRevalidate()` and the
  capability-settled listener, so `<Form capability>` and `callCapability()`
  for any non-`read` effect), a `<Form>` whose submission succeeds, and a
  `<Form>` redirect that reloads route state dispatch
  `pracht:server-islands-refresh` on `window`. A refresh keeps the current HTML
  until the new one arrives; a refresh that yields no fragment (signed out,
  unbound, failed) shows the fallback so the previous visitor's HTML does not
  linger; a network failure keeps what is on screen. Every dispatch sits behind
  the `__PRACHT_SERVER_ISLANDS__` define, placed first in the condition so apps
  without server islands fold it out. Islands and `none` pages need no hook:
  their mutations are document navigations or, for capabilities, a reload.
- **Islands bootstrap** — gated by `__PRACHT_SERVER_ISLANDS__` (true only when
  the server islands directory exists at build time), it listens for
  `pracht:server-island` once per document and runs `scheduleIslands()` over
  the swapped server island. That is the same pass the page scan, slot moves,
  and islands-navigation swaps use, so the shared `scheduled` set keeps an
  island any two of them find from hydrating twice. After moving children into
  a slot it dispatches `pracht:server-islands-scan` (above). With the flag
  false the bootstrap is byte-identical to an app without server islands
  (`pnpm bench:check`).

## Request Flow — cached page

```
BROWSER                                SERVER / CDN
GET /pricing ───────────────────────►  prerendered HTML (shared, cacheable)
◄── <pracht-server-island pending>fallback</pracht-server-island>
    <script type=module src=server-islands-client.js>
GET /assets/server-islands-client*.js  static
GET /__pracht/server-island?island=…&path=/pricing&props=…
    x-pracht-server-island: 1, Cookie ►  match /pricing → is the island bound to it?
                                        → route middleware chain
                                        → loader(context, props, signal)
                                        → render fragment
◄── 200 text/html, x-pracht-server-island: 1, Cache-Control: private, no-store
swap innerHTML, remove `pending`
(islands in the fragment → load the islands bootstrap → hydrate)
```

On an SSR page the server island is part of the one document response.

## Trust Decisions

- **Props are unsigned and untrusted.** Signing (HMAC) was considered and
  rejected twice. On a cached page the signed value is computed at build or
  regeneration time and shared by every visitor, so it proves only "some page
  render produced these props" and carries nothing about the visitor; a server
  island still must not authorize from them. It would need a secret available
  at build time and at runtime on every adapter, rotated without invalidating
  every prerendered page, and client navigation on full-hydration pages would
  have no signature to send. The route binding closes what signing the
  (island, route) pair would have closed, without any of that. The site page
  states the one rule: props are untrusted input; authorize from `context`
  inside the loader.
- **The page path is still the caller's**, within the routes that render the
  server island. `context` is what that route's middleware built.
- **GET-only, custom header required.** A top-level navigation or a cross-site
  `fetch` cannot reach a server island, so the endpoint is not a
  reflected-content or CSRF vector. Middleware side effects (a session cookie
  refresh) run as they would for the page's own `GET`; server island loaders
  should be side-effect free.

## Caching and Adapters

The endpoint is dispatched by the core runtime, so every server adapter serves
it with no adapter code. Responses are `private, no-store`. Adapters only cache
ISG pages by prerendered path (Node, Netlify, Vercel) or by ISG route match
(Cloudflare Workers Caching); `findCacheableIsgRoute()` excludes the endpoint
explicitly so a catch-all ISG route cannot make it edge-cacheable. ISG
regeneration renders the document in defer mode, so a regenerated page never
contains a visitor's server island.

The static adapter has no server: `ServerIslandBoundary` throws while
prerendering for a static target, failing the build with a pointer to islands.

## CSP

The swap script is an external module, never inline, so shared documents need
no nonce (`script-src 'self'`, `connect-src 'self'`). See [CSP.md](CSP.md).

## Cost

- Apps without a server islands directory: 0 client bytes (no entry, flags
  folded, bench baseline unchanged) and no endpoint. Server work: one
  `hasRegisteredServerIslands()` check per document.
- Pages that render no pending server island: 0 bytes.
- The swap script on a `hydration: "none"` page: ~2.0 KB raw / ~1.3 KB gzip
  across its entry, its shared chunk, the deploy-base helper, and the shared
  constants (measured on `examples/islands`), all modulepreloaded.
- Full-hydration apps with server islands: the client component chunk
  (~0.5 KB gzip) plus the refresh dispatches in the router.

## Limitations

- `pracht build --analyze` does not attribute the swap script to routes.
- Islands inside a server island stay static HTML on full-hydration pages.
- `<Script strategy="beforeHydration">` inside a server island rendered by the
  endpoint has no document head to land in.
- Every module in the server islands directory is a server island; put helpers
  elsewhere.
- Render server islands from pages and shells, not from inside islands: an
  island's client code would get the placeholder component, and a pending
  server island inside an island would be filled twice.
- A server island's data is not part of route-state JSON; on full-hydration
  pages a client navigation mounts it fresh and fetches it.
- Server islands in the shell of a not-found or error document never fill: the
  endpoint finds no route for that path and the fallback stays.
- The endpoint pins `private, no-store` on its responses, but an SSR page that
  renders a server island inline is the app's own response. An app that sets a
  public `Cache-Control` on such a page caches one visitor's server island for
  all.
- On the static adapter, a server island inside an `spa` route is only reached
  in the browser, so the build cannot reject it; the fetch finds no endpoint and
  the fallback stays.
- On a client-navigation mount, and after a refresh that yields no fragment, the
  fallback is rendered into the element as its own Preact root, so it does not
  see router context.
- The endpoint and `renderPage()` build route args with `createPageRouteArgs()`
  and run middleware with `runPageMiddlewareChain()` (`runtime-route-args.ts`),
  and both validate `search` with `applyRouteSearch()`. Add page-scoped route
  args there, never at either call site. `root` (the app root's `setup()`
  state) is the exception: both set it after middleware from
  `resolveRequestRoot()`, the page in `runPageTerminal()` and the endpoint in
  its terminal, so a request middleware answers never creates one.

## Tests

- `packages/framework/test/server-islands.test.ts` — detection, placeholder and
  inline rendering, fallback on failure, islands capture, the endpoint
  (middleware, loader args, no-store, 204/4xx/500 paths, islands header), and
  route binding: the admin-gate and `params` exploits, shell lists, unknown and
  unlisted indistinguishable, and the render-time check for an unlisted server
  island (nested ones exempt).
- `packages/framework/test/server-islands-client.test.ts` — the swap script and
  the client component under jsdom (hydration keeps markup, pending fill,
  client-navigation mount, the response marker, refresh).
- `packages/framework/test/islands-client-server-islands.test.ts` — the islands
  bootstrap and the swap script together: one hydration for an island both a
  swap and the page scan find, and a server island in unplaced island children
  fetched on first show only.
- `packages/framework/test/server-islands-refresh.test.ts` — which client paths
  dispatch the refresh, and that none do without the define.
- `e2e/server-islands-dev.test.ts` and the server islands section of
  `e2e/islands-build.test.ts` — cookie-dependent content on an SSG page whose
  HTML is identical per visitor, inline SSR, islands inside a server island,
  full hydration, failure fallback, and the refusal of a server island for a
  page that does not render it, against the dev server and a Node build. The
  dev spec also covers server islands in placed and unplaced island children,
  and `e2e/islands-navigation-build.test.ts` covers pages swapped in with
  `client.islandsNavigation`: one fetch per page shown, none for a server
  island inside a carried island, and none for unplaced children until shown.
