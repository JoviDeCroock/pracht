---
title: Static export
lead: Prerender every route to static files with `@pracht/adapter-static`, with client navigation, a 404 page, and an SPA fallback.
---

`@pracht/adapter-static` prerenders every route into `dist/client/`, which works on any static host with no server.

| Option | Default | Effect |
| --- | --- | --- |
| `fallback` | none | Also write an SPA fallback document, such as `"200.html"`, for hosts that rewrite unknown URLs |
| `fallbackHead` | none | `head()` metadata for the fallback document, shared by every rewritten URL |

## What must hold

The build fails, listing every offender, unless:

- Routes are `render: "ssg"`, or loaderless `"spa"` routes with full hydration. Dynamic `ssg` routes export `getStaticPaths()`.
- No middleware, API routes, or capabilities exposed over HTTP, MCP, or WebMCP.
- With `fallback`, the `notFound` page uses full hydration.
- Vite `base` is `/` or a root-absolute path such as `/my-project/`.

## Client navigation from static files

The build writes each full-hydration route's state to `dist/client/_pracht/state/`, and client navigation fetches those files. Islands pages keep full-page navigation.

## 404 and SPA fallback

The `notFound` page is rendered to `404.html` (the GitHub Pages and S3 convention) and adopts the visited URL. With `fallback: "200.html"` plus a host rewrite for unmatched URLs, deep links into dynamic `render: "spa"` routes boot the client router and resolve the route from `window.location`.

### Dropping the router from `404.html`

On an islands or static site, the client router is the largest chunk in the build, and on `404.html` it only adopts the URL. A 404 with fixed markup can drop it:

```ts
notFound: {
  component: () => import("./routes/not-found.tsx"),
  shell: "site",
  hydration: "none",   // or "islands"
}
```

`useLocation()` then reports the synthetic prerender path, not the visited one. To show the visited URL, read it in an island:

```tsx
// src/islands/RequestedPath.tsx
export default function RequestedPath() {
  return <code>{typeof window === "undefined" ? "" : window.location.pathname}</code>;
}
```

### How the fallback behaves

- It is one document shared by every rewritten URL, so it cannot run a route's `head()`. If a fallback-rendered route exports one, set a generic `fallbackHead`; the build fails without it.
- A URL that matches a dynamic `ssg` route but was not prerendered by `getStaticPaths()` renders the `notFound` page.
- Unknown URLs get status 200 from the rewrite, so they are soft 404s. Without a `notFound` page or a catch-all SPA route they render blank, and the build warns.

## Host requirements

- Pages are written decoded as `<path>/index.html` (`/posts/caf%C3%A9` → `posts/café/index.html`), so the host must serve `index.html` for directory URLs.
- The host sets response headers. Mirror the ones you need from `dist/server/headers-manifest.json`, which records each route's headers.
- `Accept` negotiation does not apply, so agents read a page's `markdown` export at `/about.md`. Serve `.md` as `text/markdown; charset=utf-8` (nginx's default `mime.types` has no entry for it). The build names Markdown pages that got no `.md` file.

To serve a static export under a sub-path, see [Sub-path deploys](/docs/deployment#sub-path-deploys).
