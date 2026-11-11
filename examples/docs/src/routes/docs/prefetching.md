---
title: Prefetching
lead: "pracht fetches route data before navigation: automatically by default, and configurable per route and per link."
---

## How it works

After hydration, pracht watches internal links. When a prefetch triggers, it loads the route's code and fetches the route's data (the same JSON a client-side navigation uses) at the same time, in the background. A click then reuses both without a second request.

A navigation that was never prefetched makes the same two requests together, so prefetching moves the work earlier rather than changing it.

Every route defaults to `"intent"`, so most apps configure nothing.

## Strategies

| Strategy     | Trigger                                         | Set on        | Use for                     |
| ------------ | ----------------------------------------------- | ------------- | --------------------------- |
| `"intent"`   | Hover (50ms debounce) or keyboard focus         | Route, link   | Most routes                 |
| `"hover"`    | Same as `"intent"`                              | Route, link   | Alias for `"intent"`        |
| `"viewport"` | Link comes within 200px of the viewport         | Route, link   | A few likely next pages     |
| `"render"`   | As soon as the link mounts                      | Link          | The one obvious next page   |
| `"none"`     | Never                                           | Route, link   | Rarely visited pages        |

`"viewport"` and `"render"` load pages nobody has pointed at, and each one runs a loader on your server. Keep them for the few links a visitor is likely to follow rather than every link on a page.

## Per-route configuration

Override the default with the `prefetch` field on a route:

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

## Per-link configuration

Set the `prefetch` prop on `<Link>` to override the route's strategy for one link:

```tsx
import { Link } from "@pracht/core";

<Link route="pricing" prefetch="viewport">Pricing</Link>
<Link route="dashboard" prefetch="render">Dashboard</Link>
<Link route="terms" prefetch="none">Terms</Link>
```

On a plain `<a>`, set the `data-pracht-prefetch` attribute to the same values.

## Imperative prefetching

Warm a route from code, for example before opening a menu that links to it:

```ts
import { prefetch } from "@pracht/core";

await prefetch("/products/42");
await prefetch({ route: "product", params: { id: "42" } }); // typed target
```

`prefetch()` loads the route's and shell's JS chunks and its route-state JSON in one call, into the same cache a link prefetch fills. It does nothing during SSR, before hydration, or for URLs that match no route.

## Viewport prefetching

A `"viewport"` link is prefetched once, when it comes within 200px of the viewport. Links added by client-side navigation are picked up automatically.

Each prefetch runs the route's loader on the server. `"viewport"` and `"render"` prefetches run three at a time, so a long list queues instead of hitting the server at once. They are skipped when the browser reports Save-Data or a 2G connection; hover and focus prefetches still run.

## Cache behavior

- Results are cached for **30 seconds** in a bounded client-side LRU cache, then re-fetched on the next trigger.
- The cache key is pathname plus search, so different query parameters are cached separately.
- Clicking a link whose prefetch is still in flight reuses that request.
- All strategies and navigations share the cache, so a click can consume an earlier viewport prefetch.
- A mutation empties the cache, so the next click fetches fresh data, and a navigation still loading when the mutation lands refetches. Mutations are a `<Form>` submission, a non-`GET` `apiFetch()`, a successful non-read capability call, and `useRevalidate()`.

## Speculation rules

Set `speculation` on a route to have the browser warm it instead of pracht's own cache. pracht emits one `<script type="speculationrules">` block into the SSR/SSG HTML covering every opted-in route.

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

| Mode | Browser does | Use for |
| ---- | ------------ | ------- |
| `"prefetch"` | Fetches the document into its HTTP cache | Navigations that leave the SPA: full page loads, middle-clicks, new tabs |
| `"prerender"` | Renders the page in the background; a click activates it | Landing and marketing pages |

In browsers that support speculation rules, `prerender` routes skip JS prefetching so the page is not fetched twice. A speculation `prefetch` leaves the JS strategy running.

Chromium-based browsers (Chrome and Edge 121+) honour the rules. Older versions, Firefox, and Safari ignore them, and the JS `prefetch` strategy keeps working everywhere.

> [!NOTE]
> Under a Content Security Policy, allow the generated script with `'inline-speculation-rules'` in `script-src`. See [CSP](/docs/recipes/csp).

## Excluding individual links

Exclude every link with a side effect, such as a GET that logs the user out, consumes a one-time token, or records a view. A `prerender` speculation runs the destination's JavaScript, and a JS prefetch can run its loader and middleware, so either can fire the effect before the user clicks.

Speculation rules match by URL pattern, so every `<a>` and image-map `<area>` pointing at an opted-in route is a candidate:

| Attribute | Effect |
| --- | --- |
| `rel="nofollow"` | Never speculated |
| `data-pracht-speculate="off"` | Opts the element and its whole subtree out |
| `data-pracht-speculate="on"` | On a link, re-enables it inside an opted-out subtree |

```html
<!-- Turn a whole section off, re-enable one link inside it -->
<nav data-pracht-speculate="off">
  <a href="/logout">Log out</a>
  <a href="/inbox" data-pracht-speculate="on">Inbox</a>
</nav>
```

`<Link>` takes the same switch as a prop. Add `prefetch="none"` to stop the JS prefetch too, since an excluded link keeps its prefetch strategy and SPA navigation:

```tsx
<Link route="logout" speculate={false} prefetch="none">Log out</Link>
```

Only a link can opt back in: `"on"` on a container does not override an `"off"` ancestor. Changing `rel` or `data-pracht-speculate` at runtime takes effect, including a page-wide `"off"` on `<html>`.

## Shipping less JavaScript

Turn off `client.prefetch` to compile the prefetch runtime out of the client bundle. Setting every route to `prefetch: "none"` stops the fetching but still ships the runtime.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ client: { prefetch: false } })],
});
```

That saves about 1.6 KB gzip and one request on a cold load; see [Performance](/docs/performance#what-pracht-costs-a-page).

The flag defaults to `true`. With it off, the router ignores `route({ prefetch })` and `<Link prefetch>` without a warning, and `prefetch()` does nothing. Speculation rules are unaffected.
