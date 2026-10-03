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

Islands routes are MPA-style documents (like Deno Fresh): they do not load the
client router, so **navigation to, from, and between islands routes is regular
full-document navigation**. When the client router *is* loaded (you're on a
full-hydration route) and the user clicks a link to an islands or
`hydration: "none"` route, the router deliberately falls back to
`window.location` navigation. Route-state prefetching is also skipped for
these routes.

With `defineApp({ viewTransitions: true })` those full-document navigations
still animate: every page document — islands, `none`, and full — carries
`<style data-pracht-view-transitions>@view-transition{navigation:auto}</style>`
(emitted by `buildHtmlDocumentParts()` in `runtime-html.ts`, nonce'd with
`styleNonce`), which opts the browser into cross-document view transitions.
Pure CSS, so it adds no JavaScript to islands or `none` routes. Details in
ROUTING.md → View Transitions.

Partial client-side rendering of islands routes is out of scope for v1.

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

- Markup children passed into an island are static server HTML: the island can
  show, hide, or move them, but not pass them props, re-render them, provide
  context to islands among them, or place them where the HTML parser cannot
  keep a slot element (table sections, select, textarea, media sources, a
  leading summary or legend).
- Client-side navigation into/out of islands routes is full-document.
- Island props must be JSON-serializable.
- The analyze report lists all island chunks per islands route (upper bound),
  not per-page usage.

## Example

See `examples/islands` for a complete app: an SSG page with a counter island,
a `client="visible"` lazy island, a zero-JS static page, an SSR islands route,
and a regular full-hydration route side by side.
