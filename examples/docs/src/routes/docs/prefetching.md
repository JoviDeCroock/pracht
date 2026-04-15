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

After hydration, pracht sets up document-level listeners that watch for user interaction with internal links. When a prefetch is triggered, the route's server data (the same JSON payload used during client-side navigation) is fetched in the background and cached. When the user actually clicks the link, the cached data is used immediately — no second network request.

Prefetched data is held in a 30-second TTL cache. Stale entries are discarded and re-fetched on the next interaction.

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

## Viewport Prefetching

When a route uses `"viewport"`, pracht observes all `<a>` elements pointing to that route via an `IntersectionObserver` with a 200px root margin. As soon as the link scrolls near the viewport, the route data is prefetched. Each link is only observed once — after the first intersection, it is unobserved to avoid redundant work.

After client-side navigation updates the DOM, a `MutationObserver` re-scans for new viewport-prefetch links automatically.

---

## Cache Behavior

- Prefetch results are cached for **30 seconds**. After that, the entry is evicted and re-fetched on the next trigger.
- The cache is keyed by URL (pathname + search). Different query parameters are cached separately.
- If a prefetch is in flight when the user clicks the link, the in-flight promise is reused — no duplicate request.
- The cache is shared across all prefetch strategies. A viewport prefetch can be consumed by a subsequent click, and vice versa.
