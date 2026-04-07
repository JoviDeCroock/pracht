# Rendering Modes

Viact supports four rendering modes, configured per-route. Each route declares
how and when its HTML is generated.

---

## Overview

| Mode    | HTML generated       | Loader runs              | Best for                              |
| ------- | -------------------- | ------------------------ | ------------------------------------- |
| **SSG** | Build time           | Build time               | Static content: marketing, docs, blog |
| **SSR** | Every request        | Every request            | Personalized/dynamic pages            |
| **ISG** | Build + revalidation | Build + on stale request | Semi-static: pricing, catalogs        |
| **SPA** | Client only          | Client navigation        | Auth-gated dashboards, admin UI       |

---

## SSG — Static Site Generation

```typescript
route("/about", () => import("./routes/about.tsx"), { render: "ssg" });
```

HTML is generated at build time. The loader runs once during the build, and the
output is written to `dist/client/about/index.html`. No server needed for this
route — it's served as a static file.

### Dynamic SSG paths

For routes with dynamic segments, export a `prerender` function:

```typescript
// src/routes/blog-post.tsx
export async function prerender(): Promise<string[]> {
  const posts = await getAllPosts();
  return posts.map((p) => `/blog/${p.slug}`);
}

export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}
```

The build calls `prerender()` to enumerate all paths, then runs the loader
and renderer for each. Output: `dist/client/blog/hello-world/index.html`, etc.

Prerendering runs concurrently (default: 6 parallel renders).

---

## SSR — Server-Side Rendering

```typescript
route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" });
```

HTML is generated fresh on every request. The loader runs server-side, the
component renders to a string, and the full HTML is returned with hydration state.

After hydration, client-side navigation takes over — subsequent navigations
fetch only the loader data as JSON, not full HTML.

### When to use SSR

- Pages that depend on the request (cookies, auth, personalization)
- Data that changes frequently
- Pages where SEO matters and data is dynamic

---

## ISG — Incremental Static Generation

```typescript
route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: timeRevalidate(3600), // revalidate every hour
});
```

ISG generates HTML at build time (like SSG) but regenerates it after a
configurable time window. On the first request after the window expires,
the stale page is served while a new version is generated in the background.

### Time-based revalidation

```typescript
import { timeRevalidate } from "viact";

{
  revalidate: timeRevalidate(3600);
} // seconds
```

The adapter checks the file's mtime (Node) or cache timestamp (Cloudflare)
against the revalidation window. If stale, it triggers regeneration.

### Webhook-based revalidation (Phase 2)

```typescript
import { webhookRevalidate } from "viact";

{
  revalidate: webhookRevalidate({ key: "pricing-update" });
}
```

An external system POSTs to a revalidation endpoint to trigger regeneration.
Useful for CMS-driven content where you know exactly when data changes.

---

## SPA — Single Page Application

```typescript
route("/settings", () => import("./routes/settings.tsx"), { render: "spa" });
```

No server-side rendering. The server returns a minimal HTML shell, and the
route component renders entirely in the browser. The loader runs during
client-side navigation only.

### When to use SPA

- Auth-gated pages where SEO doesn't matter
- Complex interactive UIs (editors, dashboards)
- Pages where server rendering adds no value

---

## Mixing Modes

The power of per-route modes is mixing them in one app:

```typescript
export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }), // Static
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600), // Revalidating
      }),
      route("/login", () => import("./routes/login.tsx"), { render: "ssr" }), // Dynamic
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }), // Dynamic
      route("/settings", () => import("./routes/settings.tsx"), { render: "spa" }), // Client-only
    ]),
  ],
});
```

Public marketing pages are SSG (fast, cacheable). Pricing updates hourly via ISG.
Login needs SSR for CSRF/session handling. Dashboard is SSR for personalization.
Settings is SPA because it's behind auth and doesn't need SEO.

---

## How Rendering Interacts with Navigation

After the initial page load (regardless of mode), the client router handles
navigation. All subsequent route transitions use the same flow:

1. Client matches the new route
2. Fetches loader data as JSON from the server (via `x-viact-route-state-request` header)
3. Updates the component tree with new data
4. Pushes to browser history

This means even SSG routes get fresh loader data during client navigation —
the static HTML is only for the initial load and crawlers.
