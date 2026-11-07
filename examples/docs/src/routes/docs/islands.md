---
title: Islands
lead: Hydrate only the interactive components of a server-rendered page; the rest ships as HTML without JavaScript.
---

## Overview

Set `hydration: "islands"` on a route. The server renders the full HTML, and the browser loads JavaScript only for the island components the page rendered:

```ts [src/routes.ts]
route("/", "./routes/home.tsx", {
  render: "ssg",
  hydration: "islands",
});
```

`hydration` is independent of `render`:

| Hydration mode | Client JavaScript | Use for |
| -------------- | ----------------- | ------- |
| `"full"` | Full route tree and client router | App-like pages |
| `"islands"` | Islands bootstrap plus the rendered islands | Static content with a few widgets |
| `"none"` | None | Fully static pages |

Islands work with `ssg`, `isg`, and `ssr` routes. `render: "spa"` always uses full hydration.

## Create an island

Put interactive components in `src/islands/` (change it with `pracht({ islandsDir })`). Default and named component exports there are islands:

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

Render it from a route like any component:

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

On an islands route, the server wraps `Counter` in a marker with its serialized props, and the browser hydrates only that component.

## Loading strategies

Set the `client` prop on each island usage:

```tsx
<Counter start={5} />
<SearchBox client="idle" />
<NewsletterSignup client="visible" />
```

| Strategy | Hydrates | Preloaded |
| -------- | -------- | --------- |
| `load` (default) | Immediately | Yes, with `modulepreload` |
| `idle` | When the browser is idle | No |
| `visible` | When the island scrolls into view | No |

A strategy defers an island's JavaScript, not its CSS: the page links the stylesheets of every island it rendered. See [Styling](/docs/styling).

## Props and children

Island props are embedded in the HTML and revived with `JSON.parse`. Pass strings, finite numbers, booleans, `null`, arrays, and plain objects. Anything else fails the render with:

```text
Island "Counter" (src/islands/Counter.tsx) received a prop that is not JSON-serializable: ...
```

Props are fixed when the page renders, so on an `ssg` or `isg` page every visitor gets the same ones. For per-visitor content such as a cart count, use a [server island](/docs/server-islands).

### Pass server content as children

To wrap server-rendered content in an interactive component, pass it as children. The island renders `children` wherever it likes:

```tsx [src/islands/Disclosure.tsx]
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { IslandProps } from "@pracht/core";

interface DisclosureProps {
  summary: string;
  children?: ComponentChildren;
}

export default function Disclosure({ summary, children }: DisclosureProps & IslandProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {summary}
      </button>
      {open ? children : null}
    </div>
  );
}
```

```tsx [src/routes/article.tsx]
import type { RouteComponentProps } from "@pracht/core";
import Counter from "../islands/Counter.tsx";
import Disclosure from "../islands/Disclosure.tsx";

export async function loader() {
  return { entries: ["Islands take children", "Faster builds"] };
}

function Changelog({ entries }: { entries: string[] }) {
  return <ul>{entries.map((entry) => <li key={entry}>{entry}</li>)}</ul>;
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <Disclosure summary="Show the full changelog">
      <Changelog entries={data.entries} />
      <Counter start={0} />
    </Disclosure>
  );
}
```

`Changelog` renders on the server and its code never reaches the browser. Showing, hiding, or moving the children keeps the same DOM nodes, so `Counter` among them hydrates on its own and keeps its state.

Children the island does not render on the server, such as a closed disclosure's, still ship with the page, inert. Their images load and their scripts run when the island first shows them.

Text-only children are a value: `<CopyButton>npm i {pkg}</CopyButton>` gives the island one string, such as `"npm i pracht"`.

### Limits of markup children

Markup children render once, on the server:

- The island cannot pass them props or change their contents. A render function as children throws.
- Context the island provides does not reach an island among them in the browser; that island reads the default value. Pass the value as a prop. A dev warning flags this case.
- They reach the island as one opaque node, so `toChildArray(children)` and `Children.count` cannot split them into tabs or slides. Pass what the island needs as props and reach the elements through a ref.

This tabs island toggles the `hidden` attribute of panels the page marks:

```tsx [src/islands/Tabs.tsx]
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export default function Tabs({ labels, children }: { labels: string[]; children?: ComponentChildren }) {
  const [active, setActive] = useState(0);
  const panels = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panels.current!.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel, i) => {
      panel.hidden = i !== active;
    });
  }, [active]);

  return (
    <div>
      {labels.map((label, i) => (
        <button key={label} type="button" aria-pressed={i === active} onClick={() => setActive(i)}>
          {label}
        </button>
      ))}
      <div ref={panels}>{children}</div>
    </div>
  );
}
```

```tsx
<Tabs labels={["Overview", "Specs"]}>
  <section data-panel>...</section>
  <section data-panel hidden>...</section>
</Tabs>
```

### Styling and placing children

Markup children arrive inside a `<pracht-slot>` element with `display: contents` (a `<g>` inside SVG). A child combinator such as `.panel > p` written against the island's markup no longer matches them, and `:first-child` or `:nth-child()` count among the children the page passed.

Some positions cannot hold that element, such as directly inside a table row, `<select>`, or `<video>`. Rendering children there throws:

```text
Island "Tabs" (src/islands/Tabs.tsx) renders its children directly inside <tr>. Children arrive in a <pracht-slot> element, which the browser cannot keep there. Render that markup inside the island, or pass the whole element as children.
```

The browser also moves invalid nesting, such as a `<div>` in children placed inside a `<p>`, or an `<a>` inside another `<a>`. `pracht dev` throws for the nesting it can see. If children are moved anyway, the island stays server HTML and the console logs `Island "<file>" was not hydrated: the HTML parser moved its children`. Raw HTML in children must be well-formed, and an HTML minifier must keep comments.

## Navigation

Islands routes do not load the client router. Navigation to, from, and between them is a full-document navigation, including links from a full-hydration route to an islands or `hydration: "none"` route.

With `defineApp({ viewTransitions: true })`, those page loads animate as [cross-document view transitions](/docs/recipes/view-transitions#islands-and-static-pages) without extra JavaScript.

### Client-side navigation between islands pages

Turn on `islandsNavigation` to keep the document when a link goes from one islands page to another:

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  client: { islandsNavigation: true },
});
```

The islands bootstrap fetches the next page's HTML and swaps it in:

- The URL, title, and stylesheets change. New islands hydrate with their own `client` strategy.
- An island both pages render with the same props and children, such as a cart button in a shared shell, stays mounted and keeps its state and focus. Elsewhere, focus resets to the top of the page.
- Back and forward restore the earlier page and its scroll position.
- With `viewTransitions` on, the swap animates as a same-document view transition.

Scripts the new page shares with the old one do not run again, so a page-view counter that fires on load sees only the first page. Count later pages from the Navigation API's `navigatesuccess` event.

### When pages still load normally

These links always load a new document, without fetching first:

- links to a full-hydration route, an API route, or a URL outside your app;
- a page the browser prerendered from your speculation rules;
- any link marked `<a data-pracht-reload>`.

A fetched page also falls back to a full page load when its security headers (`Content-Security-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Referrer-Policy`, cross-origin isolation) differ from the current page's, when it has a document-level `<meta http-equiv>` or `<meta name="referrer">`, when it comes from a newer deployment, or when the response is not an islands page.

Islands navigation is off on pages whose CSP uses a nonce, inside an iframe, under a Trusted Types policy that refuses HTML strings, in browsers without the [Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API), and on a static page restored from the HTTP cache. It works on static file hosts too.

The option adds about 3.8 KB gzip to the bootstrap, and every islands page then loads the bootstrap even when it renders no island, so such a page goes from no JavaScript to about 11 KB gzip. Each islands page also carries a route table of about 150 bytes gzip for 20 routes. `hydration: "none"` pages still ship no JavaScript, so a visit that starts on one navigates with full page loads.

## Build analysis

`pracht build --analyze` counts islands routes differently from full-hydration routes:

- `"islands"` routes include the islands bootstrap plus island chunks, with no shared client entry.
- `"none"` routes report `0b` of client JavaScript.
- Island chunks are an upper bound, because which islands render is known only at render time.

> [!NOTE]
> This page is served with `hydration: "islands"`. Only the search box, the page actions, and the code-block copy buttons hydrate, each with `client="idle"`; the article itself ships no JavaScript.
