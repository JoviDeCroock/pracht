---
title: Rendering modes
lead: Choose SSG, SSR, ISG, or SPA per route to decide when its HTML is generated and how fresh it stays.
---

## Overview

Set `render` on each route. It defaults to `"ssr"`.

| Mode  | HTML generated       | Loader runs       | Use for                         |
| ----- | -------------------- | ----------------- | ------------------------------- |
| `ssg` | Build time           | Build time        | Marketing pages, docs, blogs    |
| `ssr` | Every request        | Every request     | Personalized, dynamic pages     |
| `isg` | Build + revalidation | Build + on stale  | Pricing, catalogs, semi-static  |
| `spa` | Client only          | Client navigation | Auth-gated dashboards, admin UI |

## SSG — static site generation

```ts
route("/about", "./routes/about.tsx", { render: "ssg" });
```

The loader runs once during the build, and the HTML is written to
`dist/client/about/index.html` and served as a static file.

### Dynamic SSG paths

For a route with dynamic segments, export `getStaticPaths()` and return the
params of each page to build:

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

The build renders 10 paths at a time by default (set
`pracht({ prerenderConcurrency })` to change it) and writes each page as soon as
it renders, so build memory does not grow with the size of the site.

| Path result            | Serverful adapter                              | Static export   |
| ---------------------- | ---------------------------------------------- | --------------- |
| Redirect or 4xx        | Skipped with a warning; rendered live instead  | Build fails     |
| 5xx                    | Build fails                                    | Build fails     |
| Every path skipped     | Build fails                                    | Not applicable  |

## SSR — server-side rendering

```ts
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" });
```

Every request renders fresh HTML, with the loader's data serialized for
hydration. Later client navigations fetch only the loader data as JSON.

Use SSR for pages that depend on the request (cookies, auth, personalization),
data that changes on every request, and dynamic pages that need SEO.

> [!TIP]
> If only a small part of the page is personal, such as a cart count or "signed
> in as …", keep the page `ssg` or `isg` and render that part as a
> [server island](/docs/server-islands).

## ISG — incremental static generation

```ts
import { timeRevalidate } from "@pracht/core";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: timeRevalidate(3600), // regenerate at most once an hour
});
```

ISG builds HTML like SSG, then regenerates it after a time window or an
authenticated webhook. Pass an array to use both:
`revalidate: [timeRevalidate(3600), webhookRevalidate()]`.

Node and Cloudflare serve the stale page and regenerate in the background;
Netlify and Vercel use their platform caches. [Adapters](/docs/adapters)
covers each platform.

### Webhook revalidation

```ts
import { webhookRevalidate } from "@pracht/core";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: webhookRevalidate(),
});
```

Set `PRACHT_REVALIDATE_TOKEN`, then POST the paths to refresh:

```sh
curl -X POST https://example.com/__pracht/revalidate \
  -H "Authorization: Bearer $PRACHT_REVALIDATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "paths": ["/pricing"] }'
```

The JSON response lists `revalidated`, `skipped`, and `failed` paths, and
`scope` says how far the refresh reached:

| `scope`    | Adapter            | Who sees the new page                                       |
| ---------- | ------------------ | ----------------------------------------------------------- |
| `global`   | Netlify, Vercel    | Every visitor                                               |
| `instance` | Node               | Only the server that received the POST, not its replicas    |
| `colo`     | Cloudflare         | Only the data center that received the POST                 |

With `colo`, other data centers render current content on their first uncached
request but keep a copy they already hold, and `pracht build` warns about each
such route. Add a time window to the route's policy to bound that lag. With
[Workers Caching](/docs/adapters#isg-and-workers-caching), the webhook purges
the route everywhere and reports `global`.

## SPA — single page application

```ts
route("/settings", "./routes/settings.tsx", { render: "spa" });
```

The server does not render the route component. The first document contains the
route's shell and the shell's optional `Loading` export; the component renders
in the browser once the client router has fetched its route state.

```tsx [src/shells/app.tsx]
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div class="app-shell">{children}</div>;
}

export function Loading() {
  return <p>Loading page...</p>;
}
```

Use SPA for auth-gated pages with no SEO needs, complex interactive UIs such as
editors, and pages where server rendering adds nothing.

## Mixing modes

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

## Client navigation

After the first page load, the client router handles navigation between
full-hydration routes of any render mode:

1. It matches the new route.
2. It fetches the route's loader data as JSON.
3. It renders the new route with that data.
4. It pushes the URL to browser history.

On a serverful adapter, SSG routes also get fresh loader data during client
navigation; the static HTML serves the first load and crawlers.
[Islands](/docs/islands#navigation) routes use full-document navigation unless
`client.islandsNavigation` swaps them in place.

## Hydration & `useIsHydrated`

SSR, SSG, and ISG pages arrive as rendered HTML, which the browser then
hydrates: Preact attaches event listeners to the existing DOM without
re-rendering it. While a lazy component's code loads during hydration,
`Suspense` keeps the server-rendered HTML on screen instead of the fallback.

### Detecting hydration state

`useIsHydrated()` returns `false` during server rendering and the initial
hydration pass, then `true` once the component has mounted:

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

Hydration finishes once every pending Suspense boundary has resolved.
Components that mount later, such as the next route after a client navigation,
start with `true`.

Use it to:

- render a placeholder on the server and swap in a client-only widget;
- gate browser-only APIs such as `window.innerWidth` or `localStorage`, which
  would otherwise cause a hydration mismatch;
- show a static version first and add interactivity after hydration.

## Hydration mismatch warnings

When the server HTML and the client's first render disagree, `pracht dev` shows
a red banner naming the element or component where Preact stopped. It also
flags a Suspense boundary that resolved during hydration into more or fewer than
one top-level DOM node.

The banner covers full-hydration and islands routes, in development only.

### Checking the build you are about to deploy

A production build can render different HTML than dev. To catch mismatches in
the output you deploy, keep the reporter in the production bundles:

```ts [vite.config.ts]
pracht({ adapter: nodeAdapter(), client: { hydrationWarnings: true } });
```

Build, serve the output, and walk the pages:

```bash
pracht build          # prints a notice that this build carries diagnostics
pracht preview
```

Each mismatch is logged as a `console.error` starting with `[pracht]` and listed
inside `#__pracht_hydration_mismatch__` (entries under
`[data-pracht-mismatch-list]`). A headless browser can assert on either:

```ts
const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.goto(url);
expect(errors.filter((text) => text.includes("Hydration mismatch"))).toEqual([]);
```

> [!WARNING]
> Turn the flag off for the build you ship: it adds bytes and shows visitors the
> banner. `pracht build` warns whenever it is on.
