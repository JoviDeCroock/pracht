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

Islands routes do not load the client router, so by default navigation to,
from, and between them is a normal full-document navigation. That includes
links from a full-hydration route to an islands or `hydration: "none"` route.

With `defineApp({ viewTransitions: true })`, these full page loads still
animate as
[cross-document view transitions](/docs/recipes/view-transitions#islands-and-static-pages),
without adding JavaScript.

### Client-side navigation between islands pages

Turn on `islandsNavigation` to keep the document when a link goes from one
islands page to another:

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  client: { islandsNavigation: true },
});
```

The islands bootstrap then fetches the next page's HTML and swaps it in. The
URL, title, and stylesheets change. An island that both pages render with the
same props, such as a cart button in a shared shell, stays mounted and keeps
its state. New islands hydrate with their own `client` strategy. Back and
forward restore the earlier page and its scroll position. With
`viewTransitions` on, the swap animates as a same-document view transition.

Links to anything else load a new document as before, and are never fetched
first: a full-hydration route, an API route, a URL outside your app, a page
the browser has prerendered from your speculation rules, and any link marked
`<a data-pracht-reload>`.

Scripts the new page shares with the old one do not run again, so a page-view
counter that fires on load sees only the first page. Count the rest from the
Navigation API's `navigatesuccess` event.

### When pages still load normally

A swapped-in page runs under the security headers the document was first
loaded with, so the bootstrap only swaps a page whose `Content-Security-Policy`,
`X-Frame-Options`, `Permissions-Policy`, `Referrer-Policy`, and cross-origin
isolation headers are exactly the same as the current page's. Otherwise you
get a full page load, which applies that page's own headers.

The same happens for a page with a document-level `<meta>` (`http-equiv` such as a CSP or a
refresh, or `name="referrer"`), a page from a newer deployment, a redirect to a
page that cannot be swapped, and a response that is not an islands page, such
as a plain-text error or a file download.

The comparison fails closed. On a server running pracht, each page states
which headers pracht set and the browser checks them against the headers that
arrived. On static output, the browser asks the host which headers it sends
for the page you started on and swaps in only pages that arrive with the same,
so it works on any static file host. A route that answers with different
headers is fetched once, then loaded normally for the rest of the tab's
session.

Pages whose CSP uses a nonce never take part: a nonce changes with every
response, so no two such pages can share a policy. Islands navigation is off on
those pages, and links to them are plain page loads.

It also stays off inside an iframe, on a document with a document-level
`<meta>`, under a Trusted Types policy that refuses HTML strings, in browsers
without the
[Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API),
and on a static page the browser restored from its HTTP cache.

The option adds about 3.4 KB gzip to the bootstrap. Each islands page carries
the route table it decides with — the paths of your islands and `none` routes,
plus API or full-hydration routes that could shadow one — at about 150 bytes
gzip for 20 routes. Every islands page loads the bootstrap even when it renders
no island. `hydration: "none"` pages still ship no JavaScript, so navigation
from a page you landed on directly is a full page load.

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
