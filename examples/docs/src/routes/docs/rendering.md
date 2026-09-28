---
title: Rendering Modes
lead: pracht supports four rendering modes, configured per route. Each route declares how and when its HTML is generated, so every page gets its own performance and freshness trade-off.
breadcrumb: Rendering Modes
prev:
  href: /docs/routing
  title: Routing
next:
  href: /docs/islands
  title: Islands
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

HTML is generated at build time. The loader runs once during the build, and the output is written to `dist/client/about/index.html` and served as a static file.

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

The build runs the loader and renderer for each returned path, 10 at a time by
default (`pracht({ prerenderConcurrency })`).

With a serverful adapter, a path that prerenders a redirect or 4xx is skipped
with a warning and rendered live instead. A 5xx fails the build, and so does a
build where every path was skipped. A static export fails on the first non-200
path.

---

## SSR — Server-Side Rendering

```ts
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" });
```

HTML is generated fresh on every request, with the loader's data serialized for hydration. Later client-side navigations fetch only the loader data as JSON.

### When to use SSR

- Pages that depend on the request (cookies, auth, personalization)
- Data that changes on every request
- Pages where SEO matters and data is dynamic

> [!TIP]
> If only a small part of the page is personal, such as a cart count or "signed
> in as …", keep the page `ssg` or `isg` and render that part as a
> [request-time region](/docs/regions).

---

## ISG — Incremental Static Generation

```ts
import { timeRevalidate } from "@pracht/core";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: timeRevalidate(3600), // revalidate every hour
});
```

ISG generates HTML at build time, like SSG, then regenerates it after a time
window or an authenticated webhook. Node and Cloudflare serve the stale page
immediately and regenerate in the background; Vercel uses native Build Output
API prerender functions. [Adapters](/docs/adapters) covers each platform.

### Webhook revalidation

```ts
import { webhookRevalidate } from "@pracht/core";

{
  revalidate: webhookRevalidate();
}
```

Set `PRACHT_REVALIDATE_TOKEN`, then POST concrete paths to
`/__pracht/revalidate` with `Authorization: Bearer <token>`.

---

## SPA — Single Page Application

```ts
route("/settings", "./routes/settings.tsx", { render: "spa" });
```

The route component is not server-rendered. The first document contains the route's shell and the shell's optional `Loading` export; the component renders in the browser after the client router fetches its route state.

```ts
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div class="app-shell">{children}</div>;
}

export function Loading() {
  return <p>Loading page...</p>;
}
```

### When to use SPA

- Auth-gated pages where SEO doesn't matter, but shell chrome should paint fast
- Complex interactive UIs (editors, rich dashboards)
- Pages where server rendering adds no value

---

## Mixing Modes

Modes mix freely in one app and one deployment:

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

After the first page load, the client router handles navigation for full-hydration routes, whatever their render mode:

1. Client matches the new route
2. Fetches loader data as JSON
3. Updates the component tree with new data
4. Pushes to browser history

On a serverful adapter, even SSG routes get fresh loader data during client navigation; the static HTML serves the first load and crawlers. [Islands](/docs/islands#navigation) routes use full-document navigation instead.

---

## Hydration & `useIsHydrated`

For SSR, SSG, and ISG pages the browser receives rendered HTML, then **hydrates** it: Preact attaches event listeners to the existing DOM without re-rendering it.

While a lazy component's code loads during hydration, `Suspense` keeps the server-rendered HTML on screen instead of showing the fallback.

### Detecting hydration state

`useIsHydrated()` returns `false` during server rendering and the initial hydration pass, then `true` once the component has mounted:

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

Hydration counts as finished once every pending Suspense boundary has resolved. Components that mount after that, such as the next route after client navigation, start with `true`.

### Common use cases

- **Client-only widgets**: Render a placeholder during SSR, swap in the real widget after hydration
- **Avoiding hydration mismatches**: Gate browser-only APIs (`window.innerWidth`, `localStorage`) behind the hydrated check
- **Progressive enhancement**: Show a static version first, enhance with interactivity after hydration

## Hydration mismatch warnings

When the server HTML and the client's first render disagree, `pracht dev` shows a red banner naming the element or component where Preact stopped. It also flags a Suspense boundary that resolved during hydration into more or fewer than one top-level DOM node.

The banner covers full-hydration and islands routes. It is development-only; production builds drop the check.

### Checking the build you are about to deploy

A production build can render different HTML than dev, so some mismatches only show up in the output you deploy. `client: { hydrationWarnings: true }` keeps the reporter in the production client and islands bundles:

```ts
// vite.config.ts
pracht({ adapter: nodeAdapter(), client: { hydrationWarnings: true } });
```

Build with it on, serve the output, and walk the pages:

```bash
pracht build          # prints a notice that this build carries diagnostics
pracht preview
```

Each mismatch is logged as a `console.error` starting with `[pracht]` and listed inside `#__pracht_hydration_mismatch__` (entries under `[data-pracht-mismatch-list]`). A headless browser can assert on either:

```ts
const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.goto(url);
expect(errors.filter((text) => text.includes("Hydration mismatch"))).toEqual([]);
```

Leave the flag off for the build you ship: it costs bytes and shows visitors the banner. `pracht build` warns whenever it is on.
