# Islands — Partial Hydration

By default pracht hydrates the whole page tree on the client. Routes can opt
into **islands hydration** instead: the server renders the full page as static
HTML, and only explicitly-marked interactive components ("islands") ship
JavaScript and hydrate in the browser. A mostly-static page ships near-zero JS.

The design borrows from Deno Fresh (an islands directory + vnode-hook island
detection with serialized props) and Astro (`load` / `idle` / `visible`
hydration strategies).

---

## Quick Start

**1. Put interactive components in `src/islands/`:**

```tsx
// src/islands/Counter.tsx
import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

interface CounterProps {
  start?: number;
}

export default function Counter({ start = 0 }: CounterProps & IslandProps) {
  const [count, setCount] = useState(start);
  return (
    <div>
      <p>Count: {count}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
```

**2. Opt the route into islands hydration:**

```typescript
// src/routes.ts
route("/", () => import("./routes/home.tsx"), {
  render: "ssg",
  hydration: "islands",
});
```

**3. Use the island like any other component:**

```tsx
// src/routes/home.tsx
import Counter from "../islands/Counter.tsx";

export function Component() {
  return (
    <section>
      <h1>Mostly static</h1>
      <Counter start={5} />
    </section>
  );
}
```

The rest of the page — headings, text, even components with `onClick`
handlers — renders as inert HTML. Only `Counter` hydrates.

---

## Hydration Modes

Every route has a hydration mode alongside its render mode:

```typescript
route(path, file, { render: "ssg", hydration: "islands" });
```

| Mode                 | Client JS loaded                        | Use case                          |
| -------------------- | --------------------------------------- | --------------------------------- |
| `"full"` _(default)_ | Full client runtime + route/shell chunks | Existing behavior, zero change    |
| `"islands"`          | Tiny islands bootstrap + islands on page | Content pages with a few widgets  |
| `"none"`             | Nothing                                  | Fully static pages                |

- `hydration` works with `ssg`, `isg`, and `ssr` render modes and can be set
  per route or inherited from a `group(...)`.
- `render: "spa"` always uses full hydration; combining it with
  `hydration: "islands"` or `"none"` is a configuration error.
- Groups inherit: `group({ hydration: "islands" }, [...])` applies to every
  route in the group unless a route overrides it.

In the **pages router**, export a `HYDRATION` constant instead:

```tsx
// src/pages/index.tsx
export const RENDER_MODE = "ssg";
export const HYDRATION = "islands";
```

---

## Islands

### Discovery

Islands are auto-discovered from the islands directory (default
`src/islands/`, configurable via `pracht({ islandsDir })`). Every exported
function component in that directory is registered as an island — the default
export and named exports alike. This mirrors how routes, middleware, and API
modules are discovered: an explicit directory, no magic imports.

On full-hydration routes (and inside other islands), island components behave
like plain components. The islands directory only changes what happens on
`hydration: "islands"` routes.

### Hydration strategies

Each island *usage* picks a strategy via the framework-owned `client` prop
(the component itself never receives it):

```tsx
<Counter start={5} />                 {/* "load" — hydrate immediately (default) */}
<Comments client="idle" />            {/* requestIdleCallback */}
<NewsletterSignup client="visible" /> {/* IntersectionObserver: hydrate on scroll into view */}
```

- `load` islands are also `<link rel="modulepreload">`-ed by the server.
- `visible` and `idle` islands are **not** preloaded — their chunk is fetched
  only when the strategy triggers, so below-the-fold widgets cost nothing
  until they're needed.

Type the prop by intersecting `IslandProps` into your component's props:

```tsx
import type { IslandProps } from "@pracht/core";
function Widget(props: WidgetProps & IslandProps) { ... }
```

### Props

Island props are serialized to JSON in the HTML and revived in the browser, so
they must be JSON-serializable: strings, finite numbers, booleans, `null`,
arrays, and plain objects. Functions, symbols, bigints, class instances
(`Date`, `Map`, ...), JSX elements, and circular structures throw a descriptive
error during rendering that names the offending prop path.

Island props deliberately do not use the richer route-data encoding that loader
data can opt in to (see [DATA_LOADING.md](DATA_LOADING.md#what-a-loader-can-return)).
Props already fail loudly instead of changing type silently, and the islands
bootstrap would pay for the decoder on every islands page.

### Children / slots

A page can pass children into an island. Markup children are server content:
they render once on the server, never ship as JavaScript, and the island places
them wherever it renders `children`.

```tsx
<Disclosure summary="Details">
  <ServerOnlyTable rows={data.rows} />
  <Counter start={0} />
</Disclosure>
```

Children made only of strings and numbers (`<CopyButton>npm i {pkg}</CopyButton>`)
are a value, not markup: they travel in the `props` JSON as `children`, so the
island can use them as a title or clipboard string. An array of them (JSX
splits interpolated text into one) is joined into a single string on the
server, skipping `null`, `undefined`, and booleans as rendering would, so the
island receives the string it renders on both sides.

How markup children work:

- **Server.** `IslandBoundary` hands the island a slot component as
  `children`. When the island renders it, `IslandSlot` emits
  `<pracht-slot style="display:contents">` around the children, closed by an
  end-marker comment `<!--/pracht-slot-->`. Inside SVG it emits
  `<g pracht-slot>` and inside MathML `<mrow pracht-slot>`, because an unknown
  element is not rendered in those namespaces. The children render with the
  page's island capture and script capture restored, so an island among them
  (`Counter`) gets its own `<pracht-island>` marker and hydrates independently,
  and a `<Script>` there counts as outside an island. Markup children never
  enter the `props` JSON.
- **Unplaced children.** If the island's server render never placed the slot (a
  closed disclosure), a sibling rendered after the island's output emits the
  children in `<template pracht-slot>` inside the island marker, with the same
  end marker. That check runs after the island's output in render order; an
  island that suspends before placing its children emits both forms, and an
  island among them gets two markers. Only the live one is ever hydrated, so it
  costs bytes but stays correct. Unplaced SVG or MathML children are parsed as
  HTML inside the template and do not render once shown; in dev the slot ref
  logs an error when it moves them into a fresh slot outside the HTML
  namespace.
- **Client.** Before hydrating an island, the bootstrap collects every slot and
  `<template pracht-slot>` the island owns (its nearest `pracht-island`
  ancestor is this island, so a nested island's slots are left to that island)
  and treats each as a holder: the slot element, or the template's content.
  The island receives one slot vnode (same tag as the server's slot) with
  `dangerouslySetInnerHTML: { __html: "" }`: Preact never applies `innerHTML`
  while hydrating, and skips it on re-render when `__html` is unchanged, so the
  server nodes stay as they are. When the island mounts a fresh slot element
  (after hiding it), Preact sets the empty `innerHTML`, and the vnode's `ref`
  moves in the current child nodes of the first detached holder and makes the
  fresh element that holder. Moving the holder's current nodes keeps later DOM
  changes (an embed script replacing its placeholder) and node identity, so
  state in an island among the children survives. Islands that arrived in a
  template were never in the live document, so the ref schedules them with
  their strategy after the move.
- **Integrity check.** The HTML parser rearranges invalid nesting: a block
  element inside `<p>` closes the paragraph and the slot with it, nested `<a>`
  or `<button>` close the outer one, and a stray `</div>` or `</template>` in
  raw HTML closes the slot or template early. Hydrating would then delete the
  stranded nodes, which exist nowhere else. Every such move takes the end
  marker out of the holder, so the bootstrap only requires the marker to be a
  direct child of each holder; nodes after it (output an async script appended
  before hydration, whitespace from a formatter) do not count. If a marker is
  missing, the bootstrap logs an error naming the island's file and the usual
  causes, and leaves it as server HTML, which is also what an HTML minifier that strips comments causes
  (streamed Suspense hydration needs comments too). The marker stays a comment
  rather than an element so `:last-child` and sibling selectors on the children
  keep matching. A `</template>` in hidden raw HTML still
  leaks the rest of that HTML into the page at parse time, where its scripts
  run, so raw HTML in children has to be well-formed.
- **Dev nesting check.** In dev, an `options.__b` hook (preact-render-to-string
  calls it for every vnode after setting its parent) walks up from each block
  element, `<a>`, and `<button>`. If the walk crosses an `IslandSlot` before
  reaching the `<p>` (or `<a>`/`<button>`) the parser would close, with no
  scope boundary (`button` or another block element for `<p>`, `td`, `th`,
  `caption`, `table`, `template`, `object`, `svg`, `math`, ...) in between, it
  throws naming the island. Production skips the walk; raw HTML and precompiled subtrees are
  invisible to it, so the client integrity check stays the backstop.
- **Positions the parser cannot hold.** `IslandSlot` walks up
  preact-render-to-string's parent chain (`this.__v.__`) and throws, naming
  the island, when the slot would sit anywhere inside `textarea`, `title`,
  `script`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `noscript`,
  `select`, `option`, `optgroup`, or `datalist` (read as text, or the slot is
  dropped), directly inside `table`, `thead`, `tbody`, `tfoot`, `tr`, or
  `colgroup` (foster-parented out), directly inside `video`, `audio`,
  `picture`, `ruby`, or `rtc` (a `<source>`, `<track>`, or `<rt>` only works as
  their direct child, so it would silently do nothing), directly inside SVG `text`, `tspan`,
  `textPath`, `linearGradient`, `radialGradient`, `clipPath`, `filter`, or
  `switch` and MathML `mfrac`, `msup`, `msub`, `msubsup`, `mroot`, `munder`,
  `mover`, or `munderover` (fixed content models a `<g>` or `<mrow>` breaks), or
  directly inside `details` / `fieldset` with a `summary` / `legend` at the top
  level of the children or inside a top-level Fragment (which must be the first
  child; one rendered by a component is not detected). With the experimental `precompileSsrJsx`, precompiled DOM
  subtrees are not vnodes, so these checks can miss them; the integrity check
  still catches the parser moves.
- **Context.** An island among the children is a separate Preact root, so
  context the outer island provides around its children reaches it on the
  server but not in the browser. `IslandSlot` records whether a component
  between the island and the slot provides context (its component has
  `getChildContext`, excluding pracht's own capture providers), and the
  fallback sibling warns once per island in dev when the children registered
  an island.
- **Removal does not unmount.** Hiding the slot only detaches its element;
  Preact never diffed the children, so an island among them is not unmounted
  and its effects keep running while hidden.
- **`client="visible"`.** The bootstrap observes an island's element children,
  looking through `pracht-island` and `pracht-slot` wrappers, which have no
  box, and skipping `template`, `script`, and `style`. An island that renders
  only its children therefore observes the children's own elements; with no
  such element (only an unplaced `<template>`) it observes its parent.

A render function passed as children throws, also inside an array. Islands
nested *inside* an island's own render output still hydrate as part of the
outer island.

Comment-delimited slot boundaries (no wrapper element) were considered and
rejected: Preact's hydration deletes comments and any DOM node no vnode
claims, so the slot would have to detach and re-insert the server nodes during
hydration (reloading any iframe or video among them on every page load), and
its only native range-preserving path, suspended hydration between `$s`
markers, needs a Suspense boundary and Preact 11.

The bootstrap cost of children support is about 0.47 KB gzip on every islands
page.

---

## How It Works

- The generated `virtual:pracht/server` module eagerly imports every module in
  `src/islands/` and registers the exported components. A Preact
  `options.vnode` hook detects vnodes whose type is a registered island — the
  same technique Deno Fresh uses — so call sites need no special wrappers.
- On an islands-mode render, each island's SSR output is wrapped in a
  `<pracht-island island="/src/islands/Counter.tsx" export="default"
  props="...">` marker (`display: contents`, so it never affects layout).
  Detection state travels through render context, so concurrent prerenders
  can't leak islands across pages.
- The HTML document for islands routes contains **no hydration-state script
  and no client runtime**. It references only `virtual:pracht/islands-client`:
  a small bootstrap that scans the DOM for markers, dynamically imports only
  the islands present on the page (each island is its own code-split chunk),
  and hydrates each one in place with its serialized props.
- Route files used only by `hydration: "islands"` or `hydration: "none"`
  routes are also excluded from the generated full client-router entry, so
  server-only helpers imported by those page modules are not emitted into
  public client chunks. A file the manifest also names anywhere else — a full
  route, a `notFound` component, a shared constant — stays in, because the full
  route needs it to hydrate.
- If an islands route renders zero islands, no hydration script is emitted
  unless that route activates WebMCP tools through its `capabilities` metadata.
  In that case the islands bootstrap is retained because it owns the page-level
  registration; another route in the same app with no active tools still emits
  no script. `hydration: "none"` always remains zero-JS and therefore cannot
  activate in-page tools.

Test tooling can wait for `html[data-pracht-islands-hydrated="true"]` (set
after all `load` islands hydrate) and per-island `data-hydrated="true"`
attributes.

### Dev server updates

Islands themselves hot-update in place like any client component. Everything
else on an islands or `hydration: "none"` page — the route module, its shell,
and the server-only components it imports — is not part of the client bundle,
so there is no client module to patch: the dev server reloads the page instead.
A plugin that watches source files from a CSS transform — any content scanner,
Tailwind and UnoCSS among them — makes Vite record those sources as file-only
asset entries in the client graph. Those entries are watch dependencies rather
than browser modules, so they do not suppress this reload. CSS updates still
hot-update normally alongside it.
Either way, saving a file updates what you see without a manual refresh.

---

## Navigation

Islands routes are MPA-style documents by default (like Deno Fresh): they do
not load the client router, so **navigation to, from, and between islands
routes is regular full-document navigation**. When the client router *is*
loaded (you're on a full-hydration route) and the user clicks a link to an
islands or `hydration: "none"` route, the router deliberately falls back to
`window.location` navigation. Route-state prefetching is also skipped for
these routes.

With `defineApp({ viewTransitions: true })` those full-document navigations
still animate: every page document — islands, `none`, and full — carries
`<style data-pracht-view-transitions>@view-transition{navigation:auto}</style>`
(emitted by `buildHtmlDocumentParts()` in `runtime-html.ts`, nonce'd with
`styleNonce`), which opts the browser into cross-document view transitions.
Pure CSS, so it adds no JavaScript to islands or `none` routes. Details in
ROUTING.md → View Transitions.

### Client-side navigation (`client.islandsNavigation`)

`pracht({ client: { islandsNavigation: true } })` makes the islands bootstrap
swap islands pages into the live document instead (`islands-navigation.ts`).
It is a client feature define, `__PRACHT_ISLANDS_NAVIGATION__`, like
`richData`: `islands-client.ts` gates every addition behind it, so with the
flag off the bootstrap is byte-identical to a build without the feature (the
bench ladder's `hydration: islands` rung pins this), and with it on the
bootstrap grows by about 3.8 KB gzip (its own rung). The server bundle reads the
same define: every islands page then emits the bootstrap, islands or not, and
the client build emits the islands entry even without an islands directory.
`hydration: "none"` pages stay zero-JS, so they can be navigated *to* softly
but a document that starts on one navigates normally.

**What the server adds.** With the flag on, every islands and `none` document
carries `<script type="application/json" id="pracht-nav">` in its head
(`islands-shared.ts` defines the format; `islandsNavigationData()` in
runtime-page.ts writes it), and every head node the server renders carries
`data-pracht-owned`:

- `r` (islands pages only — a `none` page loads no JavaScript, so it is never
  the document a visit's bootstrap reads the table from) is the route table, in
  the order the server matches: API routes, then page routes, each prefixed
  `+` when a page there can be swapped in (`islands`/`none`, not `spa`) or `-`
  otherwise. A `-` entry is kept only when some URL could match it and a later
  `+` entry (`patternsOverlap()`), so the table never lists more of the app —
  API paths included — than it needs to (`islandsNavigationRoutes()` in
  islands-server.ts). Prerendering receives the app's `apiRoutes` so SSG
  documents carry the same table as SSR ones. It is about 150 bytes gzip for
  20 routes and grows with the route count.
- `p` is `policyFingerprint()` — FNV-1a over the document-policy headers
  (`content-security-policy`, `-report-only`, `x-frame-options`, COOP, COEP,
  `permissions-policy`, `referrer-policy`, `document-policy`,
  `document-isolation-policy`, `integrity-policy`, `origin-agent-cluster`) of
  the response this document is about to be sent with (`htmlResponseHeaders()`,
  the same function `htmlResponse()` uses). Middleware runs around the render
  and may change those headers after `next()`, so `renderPage()` checks the
  stated fingerprint against the headers of the response that leaves
  (`withSentNavigationPolicy()`) and, when they differ, rewrites it in the body
  — or drops `#pracht-nav` when they now carry a nonce. Static output
  (`IS_STATIC_TARGET`) omits it: no pracht server will send that file.
- `data-pracht-owned` marks what a swap may remove. Nodes a script inserted —
  a theme style, a tag manager, Vite's dev CSS — are never touched.

A page whose CSP or CSP-Report-Only contains `'nonce-` gets neither: a nonce
changes per response, so no other page can share its policy, and fetching it
would only ever lead to a second request.

**Deciding before fetching.** The bootstrap listens to the Navigation API's
`navigate` event and intercepts only when all of these hold; otherwise the
browser navigates as usual and nothing is fetched twice:

- push/replace navigations that are cross-document (so the app's own
  `history.pushState()`/`replaceState()` and fragment changes pass through),
  same-origin (`canIntercept`), without `formData` or `downloadRequest`, and
  not reloads;
- the destination, with the deploy base stripped (outside the base: not this
  app), matches a `+` entry of the *live* document's route table (`matchRoute()`),
  using the server's matching rules (first match wins, statics compared raw, a
  parameter takes one decodable segment, a catch-all the rest), and that entry
  is not in this tab's skip list (below);
- the clicked anchor has no `data-pracht-reload`;
- the destination does not match one of the page's own `prerender`
  speculation rules (not excluded for the anchor, via
  `NavigateEvent.sourceElement`) — the client router makes the same call.

Traversals are intercepted only when the destination entry belongs to another
*page*: an entry-id → page-number map, filled on `currententrychange`, gives an
entry created by an intercepted navigation a fresh page number and any other
new entry (an app `pushState`) the page that was showing. An entry the map does
not know but the browser calls same-document was made by an earlier document of
the tab — after a reload (or a document evicted from the back/forward cache)
the browser keeps treating the entries a swap made as one document and would
change only the address — so it is treated as another page: fetched and
swapped when its route is swappable, otherwise (or before a static page's
baseline arrived) loaded with `history: "replace"`. An app `pushState()` made
before the bootstrap installed is such an entry too.

The bootstrap does not install at all without the Navigation API; in a framed
document (a page that refuses framing must get the chance to say so: a soft
swap inside a cross-origin frame would show it anyway); in a document with a
document-level `<meta>` — any `http-equiv` other than `content-type` (a CSP
stays in force for the document's life, a refresh keeps its timer) or
`name="referrer"`; when `DOMParser.parseFromString()` throws (a Trusted Types
policy that refuses HTML strings); or, for static output, when the document
came from the HTTP cache (`PerformanceNavigationTiming.transferSize` is 0),
since the headers it arrived with may not be what the host sends now.

**The policy proof.** The document's policy — every header above — is fixed
when it loads and never changes, so a swapped-in page has to arrive with
exactly the same headers. The live document's response headers are not
readable; the fetched response's are. There are two ways to know the first:

- *Server-rendered pages* (`p` present): the page says which headers pracht
  sent, middleware changes included. A fetched page is swapped in only when `policyFingerprint(response.headers)`
  equals the live `p` and the page's own `p` does too — the server meant the
  same policy for both pages, and nothing between it and the browser changed
  it. The residual assumption is a proxy that changes headers on the *initial*
  document and not on fetched ones, which a uniform proxy does not do. This
  mode never sends `HEAD`: pracht answers it by running loaders.
- *Static output* (`p` absent): at install the bootstrap asks the host what it
  sends for this page, `fetch(location.href, { method: "HEAD", cache:
  "no-store" })`, and takes that fingerprint as the baseline; fetched pages
  must match it. Nothing is intercepted until the baseline has arrived. This
  works on any static file host, including one that sends no security
  headers at all.

The fetched response's headers are compared before its body is read; on a
mismatch the body is cancelled. A route whose page fails either check is added
to a skip list in `sessionStorage` (`pracht:nav-skip:<p>`, keyed by the live
policy so a deploy that changes it starts over) and is loaded normally for the
rest of the tab's session: each route costs at most one wasted request.

**Fetching.** The destination is fetched as an ordinary GET — static hosts,
ISG, and edge caches serve it as for a document load — with the navigation's
`signal`, `cache: "force-cache"` for traversals, and one request header,
`x-pracht-capability-form: 1`: the redirect handshake enhanced forms use.
Where the browser has `NavigationPrecommitController`, the work runs in
`intercept({ precommitHandler })`, so the address commits only once the page
is known to be swappable; a fallback then simply takes the navigation's place
(a `push` stays a push). Elsewhere the address commits at once, and a fallback
first puts the previous address back with `history.replaceState()` and then
replaces that entry — so a download (a file under an islands catch-all route)
leaves the page and its address as they were.

Redirects. `handlePrachtRequest()` answers a redirect to a request carrying
that header with `204` and the absolute target in
`x-pracht-capability-redirect` (`withEnhancedCapabilityFormRedirect()`), so a
pracht server's redirects are never followed by `fetch`: an islands page at the
same origin is a new navigation to the target (`history` as the fallback's,
`state` carried on), and anything else — a full-hydration page, another
origin's login page — is a full load of the target. Neither the original (it
may have consumed a one-time token) nor the target is requested twice, and
another origin is never fetched through CORS. A redirect back to the same
address, or to a non-HTTP scheme, is a full load of the original. Redirects
from something other than pracht (a static host's trailing slash, a CDN) are
followed; when the response came from another address:

- an islands page at the same origin: its body is read under the current
  signal, then a navigation to the final URL carries the response in `info`,
  so the entry shows the final URL before the content arrives (relative URLs
  resolve against it, `navigatesuccess` reports it) and nothing is requested
  twice;
- anything else: a full load of the final URL, never the original. A followed
  redirect to another origin fails CORS and is a full load of the original,
  which such a host redirect does not mind.

A non-HTML response, a document without `#pracht-root` or with `#pracht-state`
(a full-hydration page), a module script this document never ran (another
deployment), a policy mismatch, or a document-level `<meta>` is a full load of
the URL (`navigation.navigate(url, { history, info, state })` — the `info`
marker lets it through the listener, `state` carries on). The remaining double
requests are a `+` route answering with something that cannot be swapped (a
plain-text 500 or a download every time; a policy mismatch once per route).
Error statuses that render a swappable islands document are swapped in like
any page.

**Parsing.** `DOMParser` runs with scripting disabled, which makes `<noscript>`
content live elements; each `<noscript>` is reduced to its markup as text, as a
scripting-enabled parse would.

**Swapping** (`prepareSwap()`):

- `<head>`: an incoming owned node equal (`isEqualNode`) to a live owned node
  reuses it in place; the rest are inserted ahead of the next reused node;
  owned nodes nothing reused are removed. If two stylesheets/`<style>`s both
  pages share appear in a different order, the swap is refused (a full load):
  moving a stylesheet reloads it, and leaving them in place would cascade
  differently from a page load. New stylesheets are inserted *before* the swap
  with `media="not all"` and awaited (load or error), so they are ready when
  the content appears without restyling the leaving page — including the old
  snapshot of a view transition; their own `media` is restored at commit. An
  abandoned swap removes them.
- `#pracht-root`: the incoming content is appended first, then each live
  `<pracht-island>` whose file, export, props, and strategy match an incoming
  one (by occurrence order per key) moves in place of the server markup with
  `moveBefore()` — a move between two connected places that keeps an iframe
  loaded and scroll positions and focus inside the island — or `insertBefore()`
  where the browser has no `moveBefore()` (those survive as Preact state only).
  Hydrated islands that are not carried over are unmounted with
  `render(null, el)` so effect cleanups run; then the old content is removed.
- `<html lang>` and `document.title` follow the incoming page. Body nodes
  outside `#pracht-root` are left alone.

The swap runs inside `document.startViewTransition()` when the page carries the
view-transition style and the browser supports it (a transition skipped by a
newer one is not an error). Scrolling is manual (`intercept({ scroll:
"manual" })`) and happens with the swap: traversals and URLs with a fragment use
`event.scroll()`; other navigations scroll to the top, which `event.scroll()`
does not do for a URL without a fragment. A traversal then also scrolls to
the position the page had when a swap left it (an in-memory map by entry key,
filled at commit), since not every browser restores a swapped page's position
from `event.scroll()` — Firefox leaves it at the top. Focus is manual too (`focusReset:
"manual"`, `settleFocus()`): the browser's reset would move focus out of a
carried island (a search box that navigates as you type) even though
`moveBefore()` kept it. Focus inside a carried island stays (and is put back
after an `insertBefore()` move), and focus the page moved during the swap is
left alone; otherwise it is reset the way the Navigation API resets it — the
`autofocus` element, else the body, which also moves the sequential focus
starting point to the top. Every `await` is followed by a `signal.aborted` check, and the commit
itself checks again, so an interrupted navigation never applies its swap. Its
history entry, committed immediately like any client-router push, stays.

**Scripts** (`runScripts()`), after the commit: the incoming page's new head
scripts and then the scripts in its content run in document order. Scripts
moved over from the parsed document are marked as already started and never
run, so each is replaced by a fresh copy; an external classic script without
`async`/`defer` is awaited (load or error) before the next one, so an inline
script after it sees what it defined. An external script URL that already ran
in this document — counting the scripts of the initial load — never runs
again. A script the browser refuses (Trusted Types) throws, and a failing swap
falls back to a full load.

**Rehydration.** Then `hydrateIslands()` runs again: a `WeakSet` of scheduled
islands makes it skip carried-over ones, it applies each new island's
strategy, and it sets `data-pracht-islands-hydrated` (removed at the swap) once
the `load` islands are done. An `idle`/`visible` island whose page was left
before its strategy fired is not hydrated (`isConnected` check). With WebMCP
page tools, the generated bootstrap passes `onNavigate`, which re-reads
`data-pracht-webmcp-tools` from the incoming document and re-syncs the tools.

Known limits:

- **Shared scripts do not re-run.** A head script equal on both pages is
  reused, so load-time analytics see one page view per document. The site docs
  point at `navigatesuccess`.
- **Agent-surface endpoints** (remote MCP, capability HTTP endpoints,
  `/_pracht/*`) are matched by the server before page routes but are not in
  the table. Only an app with an islands catch-all route would fetch one, and
  the non-HTML answer falls back to a load.
- **`data-pracht-islands-hydrated` can be early.** An initial-load hydration
  pass still waiting on a slow `load` island sets the marker when it finishes,
  even if a swap happened meanwhile.
- **Dev CSS.** In `pracht dev`, an island's CSS is injected by Vite and is not
  server-owned, so it stays after the island's page is left.
- **`visible` islands left unhydrated** keep their `IntersectionObserver` until
  the document unloads.
- **`data-pracht-reload`** is honoured by islands navigation only; the full
  client router has no equivalent opt-out today.

---

## Budgets and `--analyze`

`pracht build --analyze` reports islands routes honestly:

```
/ (ssg, islands)
  /assets/islands-client-Cn3fiN4b.js     904b   1.8kb
  /assets/Counter-CdBG8ITK.js            227b    298b
  ...
  total (islands bootstrap + islands, no shared entry)   7.7kb  17.6kb
/static (ssg, none)
  total (no client js)                     0b      0b
```

- Islands routes never pay for the shared client entry, so their total is just
  the islands bootstrap plus island chunks. Because island usage is only known
  at render time, the listed island chunks are an **upper bound** (every
  island in the app); at runtime a page only downloads the islands it renders.
- `hydration: "none"` routes report 0 bytes.
- Per-route budgets apply to these totals, so islands routes get realistic
  budget checks.

---

## Limitations (v1)

- Markup children passed into an island are static server HTML that reaches
  the island as one opaque slot node (`toChildArray` sees one item): the island
  can show, hide, or move them, but not pass them props, re-render them, provide
  context to islands among them, or place them where the HTML parser cannot
  keep a slot element (table sections, select, textarea, media sources, a
  leading summary or legend).
- Navigation into/out of islands routes is full-document unless
  `client.islandsNavigation` is on, and even then only between islands and
  `none` pages, in browsers with the Navigation API.
- Island props must be JSON-serializable.
- The analyze report lists all island chunks per islands route (upper bound),
  not per-page usage.

## Example

See `examples/islands` for a complete app: an SSG page with a counter island,
a `client="visible"` lazy island, a zero-JS static page, an SSR islands route,
and a regular full-hydration route side by side.
