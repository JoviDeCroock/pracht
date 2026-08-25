---
title: Prefetching
lead: pracht prefetches route data before navigation so page transitions feel instant. Prefetching is automatic by default and can be configured per route.
breadcrumb: Prefetching
prev:
  href: /docs/adapters
  title: Adapters
next:
  href: /docs/performance
  title: Performance
---

## How It Works

After hydration, pracht loads the prefetch setup and registers document-level
listeners that watch for user interaction with internal links. When a prefetch
is triggered, the route's server data (the same JSON payload used during
client-side navigation) is fetched in the background and cached. When the user
actually clicks the link, the cached data is used immediately — no second
network request.

Prefetched data is held in a small client-side LRU cache with a 30-second TTL. Stale entries are discarded and re-fetched on the next interaction.

---

## Strategies

Each route can declare a `prefetch` strategy in its route meta:

| Strategy     | Trigger                                       | Best For                                  |
| ------------ | --------------------------------------------- | ----------------------------------------- |
| `"intent"`   | Mouse hover or keyboard focus (50ms debounce) | Most routes — low overhead, high hit rate |
| `"viewport"` | Link scrolls into view (IntersectionObserver) | Navigation menus, link-heavy pages        |
| `"hover"`    | Same as intent (hover + focus)                | Alias for intent                          |
| `"none"`     | Disabled                                      | Rarely visited pages                      |

---

## Defaults

You don't need to configure anything for most apps. The default for all routes
is `"intent"` (prefetch on hover/focus).

---

## Per-Route Configuration

Override the default strategy with the `prefetch` field on a route:

```ts [src/routes.ts]
import { defineApp, route, group } from "@pracht/core";

export const app = defineApp({
  routes: [
    // Prefetch when the link enters the viewport
    route("/pricing", "./routes/pricing.tsx", {
      render: "isg",
      prefetch: "viewport",
    }),

    // Disable prefetching for a rarely visited page
    route("/terms", "./routes/terms.tsx", {
      render: "ssg",
      prefetch: "none",
    }),

    // Default: intent-based prefetching (hover/focus)
    route("/about", "./routes/about.tsx", { render: "ssg" }),
  ],
});
```

---

## Per-Link Configuration

The `prefetch` prop on `<Link>` overrides the route-level strategy for a
single link. It also accepts `"render"`, which prefetches as soon as the link
mounts:

```tsx
import { Link } from "@pracht/core";

<Link route="pricing" prefetch="viewport">Pricing</Link>
<Link route="dashboard" prefetch="render">Dashboard</Link>
<Link route="terms" prefetch="none">Terms</Link>
```

| Strategy     | Trigger                                          |
| ------------ | ------------------------------------------------ |
| `"intent"`   | Hover or focus                                   |
| `"viewport"` | Link scrolls near the viewport                   |
| `"render"`   | Immediately when the link is rendered            |
| `"none"`     | Never — overrides the route default              |

The prop renders as a `data-pracht-prefetch` attribute, so plain `<a>`
elements can opt in the same way.

---

## Imperative Prefetching

Warm a route from code — for example before opening a menu that links to it:

```ts
import { prefetch } from "@pracht/core";

await prefetch("/products/42");
await prefetch({ route: "product", params: { id: "42" } }); // typed target
```

`prefetch()` warms the route's JS chunks and caches its route-state JSON. It
is a no-op during SSR, before hydration, and for URLs that match no route.

---

## Viewport Prefetching

When a route uses `"viewport"`, pracht observes all `<a>` elements pointing to that route via an `IntersectionObserver` with a 200px root margin. As soon as the link scrolls near the viewport, the route data is prefetched. Each link is only observed once — after the first intersection, it is unobserved to avoid redundant work.

After client-side navigation updates the DOM, a `MutationObserver` observes only newly-added DOM subtrees for viewport-prefetch links automatically.

---

## Cache Behavior

- Prefetch results are cached for **30 seconds** in a bounded client-side LRU cache. After that, the entry is evicted and re-fetched on the next trigger.
- The cache is keyed by URL (pathname + search). Different query parameters are cached separately.
- If a prefetch is in flight when the user clicks the link, the in-flight promise is reused — no duplicate request.
- The cache is shared across all prefetch strategies. A viewport prefetch can be consumed by a subsequent click, and vice versa.

---

## Speculation Rules

`prefetch` is the framework's JS-side warming: it fills the route-state cache
and imports route chunks so an SPA navigation completes without a round-trip.
`speculation` is the browser-side analogue. Opt a route in and pracht emits a
single `<script type="speculationrules">` block into the SSR/SSG HTML listing
every opted-in route as a URLPattern under `href_matches`.

```ts [src/routes.ts]
import { defineApp, route, group } from "@pracht/core";

export const app = defineApp({
  routes: [
    // The browser fetches the HTML on intent (default eagerness "moderate").
    route("/", "./routes/home.tsx", { render: "ssg", speculation: "prefetch" }),

    // The browser fully renders the page in the background
    // (default eagerness "conservative"). Clicking activates that document.
    route("/pricing", "./routes/pricing.tsx", {
      render: "ssg",
      speculation: "prerender",
    }),

    // Groups pass it down; a route can override.
    group({ pathPrefix: "/docs", speculation: "prefetch" }, [
      route("/intro", "./routes/docs/intro.tsx"),
      route("/heavy", "./routes/docs/heavy.tsx", {
        speculation: { mode: "prerender", eagerness: "moderate" },
      }),
    ]),
  ],
});
```

Reach for `prerender` on landing and marketing pages, where activating an
already-rendered document makes the click instant. Reach for `prefetch` when
navigations leave the SPA — full page loads, middle-clicks, new tabs — since it
fills the browser's HTTP cache with the document itself.

Routes flagged `prerender` are dropped from JS hover-prefetch in browsers that
support speculation rules, so the page does not fetch twice. Set both fields
explicitly when you want the JS prefetch to keep running alongside a
speculation `prefetch`.

---

## Excluding Individual Links

Speculation rules match by URL pattern, so every `<a>` — and every image-map
`<area>` — pointing at an opted-in route is a candidate. Two attributes take a
link back out, and one puts it back:

| Opt-out | Effect |
| --- | --- |
| `rel="nofollow"` | Never speculated, matching the browser's own convention for links the page does not vouch for |
| `data-pracht-speculate="off"` | Opts the element and its whole subtree out |
| `data-pracht-speculate="on"` | On a link, re-enables it inside an opted-out subtree |

```html
<!-- Turn a whole section off, re-enable one link inside it -->
<nav data-pracht-speculate="off">
  <a href="/logout">Log out</a>
  <a href="/inbox" data-pracht-speculate="on">Inbox</a>
</nav>
```

`<Link>` takes the same switch as a prop:

```tsx
<Link route="logout" speculate={false} prefetch="none">Log out</Link>
```

Reach for this on any link with a side effect — a GET that logs the user out,
consumes a one-time token, or records a view. A `prerender` speculation runs the
destination's JavaScript, and a JS prefetch can run its loader and middleware,
so either path can fire that effect before the user clicks.

The two switches are independent. An excluded link keeps the ordinary SPA path:
the JS `prefetch` strategy still applies to it, and the router still intercepts
the click rather than waiting for a prerendered document that will never exist.
Set `prefetch="none"` as well to stop both.

Exclusions are emitted as a `not: { selector_matches: [...] }` clause on every
rule, and the client mirrors the same selectors, so browser and router always
agree. `"off"` wins over a `"on"` container at any nesting depth — the semantics
are fail-closed on purpose, because CSS selectors cannot express nearest-ancestor
precedence. Changing `rel` or `data-pracht-speculate` at runtime updates both
sides, including a page-wide opt-out set on `<html>`.

> [!NOTE]
> If your app sets a Content Security Policy, allow the generated script with
> `'inline-speculation-rules'` in `script-src`. See [CSP](/docs/recipes/csp).

**Browser support.** Chromium-based browsers (Chrome/Edge 121+). Pracht emits
*document rules* — `href_matches` plus `eagerness`, and `and`/`not`/
`selector_matches` for the exclusions — which landed in Chrome 121. Earlier
versions only understood explicit URL lists and ignore the script; Firefox and
Safari ignore it too. The JS `prefetch` strategy is the cross-browser fallback
and keeps working everywhere.

---

## Shipping Less JavaScript

The prefetch listeners live in a chunk the router lazily imports on every page.
Setting every route to `prefetch: "none"` stops the fetching but still ships
that chunk — `initClientRouter()` reaches the prefetch runtime directly, so no
bundler can prove nothing uses it.

`client.prefetch` gates it on a compile-time flag instead, which turns the
branch, the modules only it reaches, and the lazily imported chunk into dead
code:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ client: { prefetch: false } })],
});
```

On `examples/basic` this drops the router runtime from 9,917 to 7,286 gzip
bytes and a cold load from 21,087 to 18,692, with one fewer request.

The flag defaults to `true`, so apps that configure nothing are unchanged byte
for byte. Turn it off only when the app really does not prefetch: with it off
the router silently stops honouring `route({ prefetch })` and `<Link prefetch>`,
and the imperative `prefetch()` export becomes a no-op. Speculation rules are
emitted server-side and are unaffected.
