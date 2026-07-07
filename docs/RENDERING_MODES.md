# Rendering Modes

Pracht supports four rendering modes, configured per-route. Each route declares
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
output is written to `dist/client/about/index.html`. No server is needed for the
initial document request — it's served as a static file. Client-side navigation
uses the route-state JSON endpoint when an adapter runtime is available, and
falls back to full document navigation on purely static hosts.

### Dynamic SSG paths

For routes with dynamic segments, export a `getStaticPaths` function that
returns the params for each page to generate:

```typescript
// src/routes/blog-post.tsx
import type { LoaderArgs, RouteParams } from "@pracht/core";

export function getStaticPaths(): RouteParams[] {
  const posts = getAllPosts();
  return posts.map((p) => ({ slug: p.slug }));
}

export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}
```

The build calls `getStaticPaths()` to enumerate params, constructs full paths
from the route pattern, then runs the loader and renderer for each.
Output: `dist/client/blog/hello-world/index.html`, etc.

Dynamic params are percent-encoded before output paths are written, and exact
`.` / `..` dynamic param segments are rejected. Static route patterns cannot
contain raw dot segments or backslashes. The CLI also verifies every
prerendered file resolves inside `dist/client/` before writing.

Prerendering runs concurrently (default: 10 parallel renders). Tune it with `pracht({ prerenderConcurrency })` in your Vite config when CI needs more or less parallelism.

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

ISG generates HTML at build time (like SSG) and, on adapters with persistent
platform state, regenerates it after a configurable time window or an
authenticated webhook. Node and Cloudflare serve stale HTML immediately while a
new version is generated in the background for time-based revalidation. Vercel
uses Build Output API prerender functions and the platform ISR cache.

### Time-based revalidation

```typescript
import { timeRevalidate } from "@pracht/core";

{
  revalidate: timeRevalidate(3600);
} // seconds
```

Node checks the file's mtime against the revalidation window. Cloudflare checks
the generated timestamp stored in the Cache API entry and falls back to the
build-time asset timestamp. Vercel writes native `.prerender-config.json` files
with `expiration` set from the time policy.

### Webhook-based revalidation

```typescript
import { webhookRevalidate } from "@pracht/core";

{
  revalidate: webhookRevalidate();
}
```

An external system POSTs to the framework endpoint to trigger regeneration:

```sh
curl -X POST https://example.com/__pracht/revalidate \
  -H "Authorization: Bearer $PRACHT_REVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["/pricing"]}'
```

Set `PRACHT_REVALIDATE_TOKEN` in the runtime environment. The endpoint fails
closed with `401` when the token is unset or incorrect. Pracht also accepts the
same secret in the `x-pracht-revalidate-token` header for webhook providers
that cannot send bearer auth.

The response reports `revalidated`, `skipped`, and `failed` path arrays.
Ineligible paths (not ISG, not prerendered, no `webhookRevalidate()`) are
skipped; paths whose regeneration errored are reported in `failed` and keep
serving the previously generated copy. Concurrent regenerations of the same
path are single-flighted, so a burst of stale traffic or webhook posts
triggers one render, not N.

Dynamic ISG paths that `getStaticPaths()` did not enumerate at build time are
rendered on demand per request (uncached); webhook posts naming them are
reported as `skipped` on Node and Cloudflare because there is no generated
copy to refresh.

Webhook and time policies can be combined:

```typescript
import { timeRevalidate, webhookRevalidate } from "@pracht/core";

route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: [timeRevalidate(3600), webhookRevalidate()],
});
```

This means "regenerate hourly, or sooner when a CMS webhook names this path."

| Adapter    | Time revalidation                       | Webhook revalidation                |
| ---------- | --------------------------------------- | ----------------------------------- |
| Node       | File mtime + stale-while-revalidate     | Regenerates the on-disk HTML file   |
| Cloudflare | Cache API + `env.ASSETS` fallback       | Overwrites the Cache API entry      |
| Vercel     | Build Output API prerender `expiration` | Uses `x-prerender-revalidate`       |

Cloudflare's Cache API is per-colo. A webhook updates the colo that receives
the webhook request; other colos refresh on their next stale request or their
own webhook hit. Use shorter time windows when globally immediate invalidation
is required.

---

## SPA — Single Page Application

```typescript
route("/settings", () => import("./routes/settings.tsx"), { render: "spa" });
```

The route component is not server-rendered. On the initial document request,
pracht renders the assigned shell immediately and, if the shell exports
`Loading`, includes that placeholder in the HTML. The route component still
renders entirely in the browser after the client router fetches route-state
JSON.

```typescript
// src/shells/app.tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div class="app-shell">{children}</div>;
}

export function Loading() {
  return <p>Loading page...</p>;
}
```

This improves first paint for auth-gated apps without serializing loader data
into the initial document by default.

### When to use SPA

- Auth-gated pages where SEO doesn't matter, but shell chrome should paint fast
- Complex interactive UIs (editors, dashboards)
- Pages where server rendering adds no value

---

## Mixing Modes

The power of per-route modes is mixing them in one app:

```typescript
export const app = defineApp({
  shells: {
    public: () => import("./shells/public.tsx"),
    app: () => import("./shells/app.tsx"),
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
2. Fetches loader data as JSON from the server (via `x-pracht-route-state-request` header)
3. Updates the component tree with new data
4. Pushes to browser history

This means even SSG routes get fresh loader data during client navigation —
the static HTML is only for the initial load and crawlers.
