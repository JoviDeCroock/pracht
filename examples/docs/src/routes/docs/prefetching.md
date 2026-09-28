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

After hydration, pracht watches for interaction with internal links. When a
prefetch triggers, it fetches the route's data (the same JSON a client-side
navigation uses) in the background and caches it. When the user clicks, the
cached data is used with no second request.

---

## Strategies

Each route can declare a `prefetch` strategy in its route meta. The default for every route is `"intent"`, so most apps configure nothing.

| Strategy     | Trigger                                       | Best For                                  |
| ------------ | --------------------------------------------- | ----------------------------------------- |
| `"intent"`   | Mouse hover (50ms debounce) or keyboard focus | Most routes — low overhead, high hit rate |
| `"viewport"` | Link scrolls into view (IntersectionObserver) | Navigation menus, link-heavy pages        |
| `"hover"`    | Same as intent (hover + focus)                | Alias for intent                          |
| `"none"`     | Disabled                                      | Rarely visited pages                      |

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

On a plain `<a>`, set the `data-pracht-prefetch` attribute to the same values.

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

A `"viewport"` link is prefetched once, when it comes within 200px of the viewport. Links added by client-side navigation are picked up automatically.

---

## Cache Behavior

- Prefetch results are cached for **30 seconds** in a bounded client-side LRU cache, then re-fetched on the next trigger.
- The cache is keyed by pathname and search, so different query parameters are cached separately.
- Clicking a link whose prefetch is still in flight reuses that request.
- All strategies and navigations share the cache. A viewport prefetch can be consumed by a later click.

---

## Speculation Rules

`prefetch` warms pracht's own route-state cache and route chunks for SPA
navigation. `speculation` asks the browser to do the warming instead. Opt a
route in and pracht emits one `<script type="speculationrules">` block into
the SSR/SSG HTML covering every opted-in route.

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

Use `prerender` on landing and marketing pages, where activating an
already-rendered document makes the click instant. Use `prefetch` when
navigations leave the SPA — full page loads, middle-clicks, new tabs — since it
fills the browser's HTTP cache with the document.

In browsers that support speculation rules, `prerender` routes skip JS
prefetching so the page is not fetched twice. A speculation `prefetch` leaves
the JS strategy running.

---

## Excluding Individual Links

Speculation rules match by URL pattern, so every `<a>` and image-map `<area>`
pointing at an opted-in route is a candidate. Two attributes take a link back
out, and one puts it back:

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

Use this on any link with a side effect — a GET that logs the user out,
consumes a one-time token, or records a view. A `prerender` speculation runs
the destination's JavaScript, and a JS prefetch can run its loader and
middleware, so either can fire the effect before the user clicks.

The two switches are independent. An excluded link still gets its JS
`prefetch` strategy and SPA navigation. Set `prefetch="none"` as well to stop
both.

Only a link itself can opt back in: `"on"` on a container does not override an
`"off"` ancestor. Changes to `rel` or `data-pracht-speculate` at runtime take
effect, including a page-wide `"off"` on `<html>`.

> [!NOTE]
> If your app sets a Content Security Policy, allow the generated script with
> `'inline-speculation-rules'` in `script-src`. See [CSP](/docs/recipes/csp).

**Browser support.** Chromium-based browsers (Chrome/Edge 121+) honour the
rules. Older versions, Firefox, and Safari ignore them. The JS `prefetch`
strategy keeps working everywhere.

---

## Shipping Less JavaScript

Setting every route to `prefetch: "none"` stops the fetching but still ships
the prefetch runtime. To compile it out, turn off `client.prefetch`:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ client: { prefetch: false } })],
});
```

That saves about 1.5 KB gzip and one request on a cold load; see
[Performance](/docs/performance#what-pracht-costs-a-page).

The flag defaults to `true`. Turn it off only when the app does not prefetch:
the router then silently ignores `route({ prefetch })` and `<Link prefetch>`,
and `prefetch()` becomes a no-op. Speculation rules are unaffected.
