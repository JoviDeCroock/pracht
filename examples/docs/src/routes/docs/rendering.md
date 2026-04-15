---
title: Rendering Modes
lead: pracht supports four rendering modes configured per route. Each route declares how and when its HTML is generated — giving you the right performance and freshness trade-off for every page in one app.
breadcrumb: Rendering Modes
prev:
  href: /docs/routing
  title: Routing
next:
  href: /docs/data-loading
  title: Data Loading
---

## Overview

| Mode | HTML generated       | Loader runs       | Best for                        |
| ---- | -------------------- | ----------------- | ------------------------------- |
| SSG  | Build time           | Build time        | Marketing pages, docs, blogs    |
| SSR  | Every request        | Every request     | Personalized, dynamic pages     |
| ISG  | Build + revalidation | Build + on stale  | Pricing, catalogs, semi-static  |
| SPA  | Client only          | Client navigation | Auth-gated dashboards, admin UI |

---

## SSG — Static Site Generation

```ts
route("/about", "./routes/about.tsx", { render: "ssg" });
```

HTML is generated at build time. The loader runs once during the build, and the output is written to `dist/client/about/index.html`. No server required for this route — it's served as a static file from your CDN.

### Dynamic SSG paths

For routes with dynamic segments, export a `getStaticPaths` function that returns the params for each page:

```ts [src/routes/blog-post.tsx]
export function getStaticPaths(): RouteParams[] {
  const posts = getAllPosts();
  return posts.map(p => ({ slug: p.slug }));
}

export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}

export function Component({ data }) {
  return <article>{data.post.title}</article>;
}
```

The build calls `getStaticPaths()` to enumerate params, constructs full paths from the route pattern, then runs the loader and renderer for each. Prerendering runs concurrently (default: 6 parallel renders).

---

## SSR — Server-Side Rendering

```ts
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" });
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
import { timeRevalidate } from "@pracht/core";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: timeRevalidate(3600), // revalidate every hour
});
```

ISG generates HTML at build time (like SSG) but regenerates it after a configurable time window. On the first request after the window expires, the stale page is served immediately while a new version regenerates in the background — stale-while-revalidate.

> [!INFO]
> ISG revalidation is implemented at the adapter level. The Node adapter uses file `mtime`; Cloudflare uses a cache timestamp in KV.

### Webhook revalidation

> [!WARNING]
> `webhookRevalidate` is planned but **not yet exported** from `@pracht/core`. The snippet below shows the intended API — it will ship in a future release. Use `timeRevalidate` for now.

```ts
import { webhookRevalidate } from "@pracht/core";

{
  revalidate: webhookRevalidate({ key: "pricing-update" });
}
// POST to the revalidation endpoint to trigger regeneration
```

---

## SPA — Single Page Application

```ts
route("/settings", "./routes/settings.tsx", { render: "spa" });
```

The route component is not server-rendered. On the first document request, pracht renders the assigned shell immediately and includes an optional shell `Loading` export if you provide one. The route component still renders entirely in the browser after the client router fetches route-state JSON.

```ts
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div class="app-shell">{children}</div>;
}

export function Loading() {
  return <p>Loading page...</p>;
}
```

This improves first paint without serializing loader data into the initial document by default.

### When to use SPA

- Auth-gated pages where SEO doesn't matter, but shell chrome should paint fast
- Complex interactive UIs (editors, rich dashboards)
- Pages where server rendering adds no value

---

## Mixing Modes

The real power is mixing modes in a single app without separate deployments or frameworks:

```ts
export const app = defineApp({
  routes: [
    group({ shell: "public" }, [
      route("/", "...", { render: "ssg" }), // Static
      route("/pricing", "...", {
        render: "isg", // Revalidating
        revalidate: timeRevalidate(3600),
      }),
      route("/login", "...", { render: "ssr" }), // Dynamic
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "...", { render: "ssr" }), // Personalized
      route("/settings", "...", { render: "spa" }), // Client-only
    ]),
  ],
});
```

---

## Client Navigation

After the initial page load — regardless of render mode — the client router handles all navigation. Route transitions use the same flow:

1. Client matches the new route
2. Fetches loader data as JSON via `x-pracht-route-state-request` header
3. Updates the component tree with new data
4. Pushes to browser history

This means even SSG routes get fresh loader data during client navigation. The static HTML is only for the initial load and crawlers.

---

## Hydration & `useIsHydrated`

When pracht server-renders a page (SSR, SSG, ISG), the browser receives fully rendered HTML. The client then **hydrates** — it attaches event listeners and Preact's component tree to the existing DOM without re-rendering it.

During hydration, `Suspense` boundaries behave differently than on the client: lazy components throw promises, but Suspense keeps the server-rendered HTML alive instead of swapping to the fallback. The resolved content stays visible while the component code loads.

### Detecting hydration state

`useIsHydrated()` returns `false` during server rendering and the initial hydration pass, then `true` once the component has mounted on the client:

```tsx
import { useIsHydrated } from "@pracht/core";

export function Component({ data }) {
  const hydrated = useIsHydrated();

  return (
    <div>
      <h1>{data.title}</h1>
      {hydrated && <InteractiveWidget />}
    </div>
  );
}
```

### How it works

The framework tracks in-flight Suspense boundaries during hydration. Each thrown promise increments a counter; each settled promise decrements it. After a render cycle completes with zero pending suspensions, hydration is marked as finished.

The hook itself is simple:

```ts
const [hydrated, setHydrated] = useState(_hydrated);
useEffect(() => {
  setHydrated(true);
}, []);
return hydrated;
```

`useState(_hydrated)` captures the global flag at render time. If the component renders while suspensions are still pending, it starts with `false`. Components that mount after hydration has finished (e.g. a lazy-loaded route component that just resolved) start with `true` immediately.

### Common use cases

- **Client-only widgets**: Render a placeholder during SSR, swap in the real widget after hydration
- **Avoiding hydration mismatches**: Gate browser-only APIs (`window.innerWidth`, `localStorage`) behind the hydrated check
- **Progressive enhancement**: Show a static version first, enhance with interactivity after hydration
