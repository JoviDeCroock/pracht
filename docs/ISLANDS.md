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

Passing children into an island from a server component is **not supported in
v1** and throws a clear error. Move the content inside the island, or pass it
as a serializable prop. (Islands may of course render their own children
internally, and islands nested *inside* another island hydrate as part of the
outer island.)

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
- Routes configured with `hydration: "islands"` or `hydration: "none"` are
  also excluded from the generated full client-router entry, so server-only
  helpers imported by those page modules are not emitted into public client
  chunks.
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
bootstrap grows by about 3 KB gzip (its own rung). The server bundle reads the
same define: every islands page then emits the bootstrap, islands or not, and
the client build emits the islands entry even without an islands directory.
`hydration: "none"` pages stay zero-JS, so they can be navigated *to* softly
but a document that starts on one navigates normally.

**What the server adds.** With the flag on, every islands and `none` document
carries `<script type="application/json" id="pracht-nav">{"p":…,"r":[…]}</script>`
in its head (`islands-shared.ts` defines the format), and every head node the
server renders carries `data-pracht-owned`:

- `r` is the route table, in the order the server matches: API routes first,
  then page routes, each prefixed `+` when a page there can be swapped in
  (`islands`/`none`, not `spa`) and `-` otherwise, truncated after the last `+`
  (`islandsNavigationRoutes()` in islands-server.ts). Prerendering receives the
  app's `apiRoutes` so SSG documents carry the same table as SSR ones.
- `p` is `policyFingerprint()` — FNV-1a over the document-policy headers
  (`content-security-policy`, `-report-only`, `x-frame-options`, COOP, COEP,
  `permissions-policy`, `referrer-policy`, `document-policy`,
  `origin-agent-cluster`) of the response this document is about to be sent
  with (`htmlResponseHeaders()`, the same function `htmlResponse()` uses).
- `data-pracht-owned` marks what a swap may remove. Nodes a script inserted —
  a theme style, a tag manager, Vite's dev CSS — are never touched.

**Deciding before fetching.** The bootstrap listens to the Navigation API's
`navigate` event and intercepts only when all of these hold; otherwise the
browser navigates as usual and nothing is fetched twice:

- push/replace navigations that are cross-document (so the app's own
  `history.pushState()`/`replaceState()` and fragment changes pass through),
  same-origin (`canIntercept`), without `formData` or `downloadRequest`, and
  not reloads;
- the destination, with the deploy base stripped (outside the base: not this
  app), matches a `+` entry of the *live* document's route table, using the
  server's matching rules (first match wins, statics compared raw, a parameter
  takes one decodable segment, a catch-all the rest);
- the clicked anchor has no `data-pracht-reload`;
- the destination does not match one of the page's own `prerender`
  speculation rules (not excluded for the anchor, via
  `NavigateEvent.sourceElement`) — the client router makes the same call.

Traversals are intercepted only when the destination entry belongs to another
*page*: an entry-id → page-number map, filled on `currententrychange`, gives an
entry created by an intercepted navigation a fresh page number and any other
new entry (an app `pushState`) the page that was showing.

The bootstrap does not install at all without the Navigation API, in a framed
document (a page that refuses framing must get the chance to say so: a soft
swap inside a cross-origin frame would show it anyway), in a document with a
`<meta http-equiv="Content-Security-Policy">` (it stays in force for the
document's life), or when this tab already saw the host change policy headers
(below).

**The policy proof.** The document's policy — every header above — is fixed
when it loads and never changes, so a swapped-in page has to run under exactly
that policy. The live document's response headers are not readable, but its
`p` says what the server sent; the fetched response's headers are readable.
A page is swapped in only when its own `p` equals the live document's `p`
*and* `policyFingerprint(response.headers)` equals it too — so the server meant
the same policy for both pages, and nothing between the server and the
browser changed it. A host that adds, drops, or rewrites any of those headers
(a static file host sending none of pracht's defaults, a CDN adding CSP) makes
the second comparison fail for every page, so the bootstrap records
`pracht:host-policy` = `p` in `sessionStorage` and stops intercepting for the
rest of the tab's session: one extra request, once. The residual assumption is
a host that changes headers on the *initial* document and not on fetched ones,
which a uniform host does not do. A response with a meta CSP falls back.

**Fetching.** The destination is fetched as plain `fetch(url)` — no special
header, so static hosts, ISG, and edge caches serve it as for a document load —
with the navigation's `signal`, and `cache: "force-cache"` for traversals.
Redirects are followed. When the response came from another address:

- an islands page at the same origin: its body is read under the current
  signal, then a `replace` navigation to the final URL carries the response in
  `info`, so the entry shows the final URL before the content arrives
  (relative URLs resolve against it, `navigatesuccess` reports it) and nothing
  is requested twice;
- anything else: a full load of the final URL, never the original — the
  original may have consumed something (a one-time token) on the way.

A non-HTML response, a document without `#pracht-root` or with `#pracht-state`
(a full-hydration page), a module script this document never ran (another
deployment), a policy mismatch, or a meta CSP is a full load of the URL
(`navigation.navigate(url, { history: "replace", info, state })` — the `info`
marker lets it through the listener, `state` carries on — or `location.reload()`
when only the fragment differs). That fetch was spent: the remaining double
requests are a `+` route answering with something that cannot be swapped (a
plain-text 500, a different policy), and a redirect into a full-hydration
page, whose final URL is requested twice. Error statuses that render a
swappable islands document are swapped in like any page.

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
  loaded, focus, and scroll positions inside the island — or `insertBefore()`
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
does not do for a URL without a fragment. Focus uses the Navigation API
default. Every `await` is followed by a `signal.aborted` check, and the commit
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

- Children/slots from server components into islands: unsupported (throws).
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
