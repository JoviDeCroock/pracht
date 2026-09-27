---
title: Islands
lead: Islands let mostly static routes hydrate only the components that need browser interactivity. The rest of the document stays server-rendered HTML with little or no JavaScript.
breadcrumb: Islands
prev:
  href: /docs/rendering
  title: Rendering Modes
next:
  href: /docs/data-loading
  title: Data Loading
---

## Overview

A docs page might need only a search box, and a pricing page only a
calculator. Islands hydration renders the full HTML on the server and ships
JavaScript only for those interactive widgets.

```ts [src/routes.ts]
route("/", "./routes/home.tsx", {
  render: "ssg",
  hydration: "islands",
});
```

`hydration` is separate from `render`:

| Hydration mode | Client JavaScript | Best for |
| -------------- | ----------------- | -------- |
| `"full"` | Full route tree and client router | App-like pages and existing routes |
| `"islands"` | Islands bootstrap plus rendered islands | Static content with a few widgets |
| `"none"` | No framework JavaScript | Fully static pages |

`render: "spa"` always uses full hydration. Islands work with `ssg`, `isg`,
and `ssr` routes.

---

## Create an Island

Put interactive components in `src/islands/`. Pracht auto-discovers default and
named component exports from that directory.

```tsx [src/islands/Counter.tsx]
import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

interface CounterProps {
  start?: number;
}

export default function Counter({ start = 0 }: CounterProps & IslandProps) {
  const [count, setCount] = useState(start);

  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count: {count}
    </button>
  );
}
```

Use the island from a route like a normal component:

```tsx [src/routes/home.tsx]
import Counter from "../islands/Counter.tsx";

export function Component() {
  return (
    <main>
      <h1>Mostly static</h1>
      <p>This content renders as HTML and never hydrates.</p>
      <Counter start={5} />
    </main>
  );
}
```

On an islands route, the server wraps `Counter` in a marker, serializes its
props, and the browser hydrates only that component.

---

## Loading Strategies

Set the framework-owned `client` prop per island usage:

```tsx
<Counter start={5} />
<SearchBox client="idle" />
<NewsletterSignup client="visible" />
```

| Strategy | Behavior |
| -------- | -------- |
| `load` | Hydrates immediately and is modulepreloaded. This is the default. |
| `idle` | Hydrates when the browser is idle. |
| `visible` | Hydrates after the island scrolls into view. |

`idle` and `visible` islands are not preloaded, so below-the-fold widgets
fetch their chunks only when needed.

A strategy defers an island's JavaScript, never its styles: every rendered
island's CSS is in the page's document. See [Styling](/docs/styling).

---

## Props and Children

Island props are embedded in the HTML and revived with `JSON.parse`, so they
must be JSON-serializable: strings, finite numbers, booleans, `null`, arrays,
and plain objects.

Do not pass functions, class instances like `Date`, JSX elements, symbols,
bigints, or circular objects as island props. Pracht throws an error that names
the invalid prop path.

Children passed from server components into islands are not supported in v1.
Move the content inside the island or pass serializable data instead.

---

## Navigation

Islands routes do not load the client router, so navigation to, from, and
between them is a normal full-document navigation. That includes links from a
full-hydration route to an islands or `hydration: "none"` route.

---

## Build Analysis

`pracht build --analyze` counts islands routes differently from full hydration
routes:

- `"islands"` routes include the islands bootstrap plus island chunks, with no
  shared client entry.
- `"none"` routes report `0b` of client JavaScript.
- Island chunks are reported as an upper bound, because which islands render
  is only known at render time.

> [!NOTE]
> This documentation page is itself wired with `hydration: "islands"` in the
> example docs app. It renders no island components, so its generated HTML ships
> no framework JavaScript.
