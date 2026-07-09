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
- If an islands route renders zero islands, no script tag is emitted at all —
  the output is as static as `hydration: "none"`.

Test tooling can wait for `html[data-pracht-islands-hydrated="true"]` (set
after all `load` islands hydrate) and per-island `data-hydrated="true"`
attributes.

---

## Navigation

Islands routes are MPA-style documents (like Deno Fresh): they do not load the
client router, so **navigation to, from, and between islands routes is regular
full-document navigation**. When the client router *is* loaded (you're on a
full-hydration route) and the user clicks a link to an islands or
`hydration: "none"` route, the router deliberately falls back to
`window.location` navigation. Route-state prefetching is also skipped for
these routes.

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

- Children/slots from server components into islands: unsupported (throws).
- Client-side navigation into/out of islands routes is full-document.
- Island props must be JSON-serializable.
- The analyze report lists all island chunks per islands route (upper bound),
  not per-page usage.

## Example

See `examples/islands` for a complete app: an SSG page with a counter island,
a `client="visible"` lazy island, a zero-JS static page, an SSR islands route,
and a regular full-hydration route side by side.
