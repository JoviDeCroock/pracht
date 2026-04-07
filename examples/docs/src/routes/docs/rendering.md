---
title: Rendering Modes
lead: viact supports four rendering modes configured per route. Each route declares how and when its HTML is generated — giving you the right performance and freshness trade-off for every page in one app.
breadcrumb: Rendering Modes
prev:
  href: /docs/routing
  title: Routing
next:
  href: /docs/data-loading
  title: Data Loading
---

## Overview

| Mode | HTML generated | Loader runs | Best for |
|------|---------------|-------------|----------|
| SSG | Build time | Build time | Marketing pages, docs, blogs |
| SSR | Every request | Every request | Personalized, dynamic pages |
| ISG | Build + revalidation | Build + on stale | Pricing, catalogs, semi-static |
| SPA | Client only | Client navigation | Auth-gated dashboards, admin UI |

---

## SSG — Static Site Generation

```ts
route("/about", "./routes/about.tsx", { render: "ssg" })
```

HTML is generated at build time. The loader runs once during the build, and the output is written to `dist/client/about/index.html`. No server required for this route — it's served as a static file from your CDN.

### Dynamic SSG paths

For routes with dynamic segments, export a `prerender` function to enumerate all paths:

```ts [src/routes/blog-post.tsx]
export async function prerender(): Promise<string[]> {
  const posts = await getAllPosts();
  return posts.map(p => `/blog/${p.slug}`);
}

export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}

export function Component({ data }) {
  return <article>{data.post.title}</article>;
}
```

The build calls `prerender()` to enumerate all paths, then runs the loader and renderer for each. Prerendering runs concurrently (default: 6 parallel renders).

---

## SSR — Server-Side Rendering

```ts
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" })
```

HTML is generated fresh on every request. The loader runs server-side, the component renders to a string, and the full HTML response includes the serialized hydration state.

After the initial load, client-side navigation takes over — subsequent navigations fetch only the loader data as JSON, not full HTML.

### When to use SSR

- Pages that depend on the request (cookies, auth, personalization)
- Data that changes on every request
- Pages where SEO matters and data is dynamic

---

## ISG — Incremental Static Generation

```ts
import { timeRevalidate } from "viact";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: timeRevalidate(3600), // revalidate every hour
})
```

ISG generates HTML at build time (like SSG) but regenerates it after a configurable time window. On the first request after the window expires, the stale page is served immediately while a new version regenerates in the background — stale-while-revalidate.

> [!INFO]
> ISG revalidation is implemented at the adapter level. The Node adapter uses file `mtime`; Cloudflare uses a cache timestamp in KV.

### Webhook revalidation (Phase 2)

```ts
import { webhookRevalidate } from "viact";

{ revalidate: webhookRevalidate({ key: "pricing-update" }) }
// POST to the revalidation endpoint to trigger regeneration
```

---

## SPA — Single Page Application

```ts
route("/settings", "./routes/settings.tsx", { render: "spa" })
```

No server-side rendering. The server returns a minimal HTML shell, and the component renders entirely in the browser. The loader runs during client-side navigation only.

### When to use SPA

- Auth-gated pages where SEO doesn't matter
- Complex interactive UIs (editors, rich dashboards)
- Pages where server rendering adds no value

---

## Mixing Modes

The real power is mixing modes in a single app without separate deployments or frameworks:

```ts
export const app = defineApp({
  routes: [
    group({ shell: "public" }, [
      route("/",        "...", { render: "ssg" }),           // Static
      route("/pricing", "...", { render: "isg",             // Revalidating
        revalidate: timeRevalidate(3600) }),
      route("/login",   "...", { render: "ssr" }),           // Dynamic
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "...", { render: "ssr" }),         // Personalized
      route("/settings",  "...", { render: "spa" }),         // Client-only
    ]),
  ],
});
```

---

## Client Navigation

After the initial page load — regardless of render mode — the client router handles all navigation. Route transitions use the same flow:

1. Client matches the new route
2. Fetches loader data as JSON via `x-viact-route-state-request` header
3. Updates the component tree with new data
4. Pushes to browser history

This means even SSG routes get fresh loader data during client navigation. The static HTML is only for the initial load and crawlers.
