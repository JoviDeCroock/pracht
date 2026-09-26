---
title: Request-time Regions
lead: A region is a small server-rendered part of a page that renders per request, with the visitor's cookies and middleware context, even when the page around it is prerendered and cached for everyone.
breadcrumb: Request-time Regions
prev:
  href: /docs/islands
  title: Islands
next:
  href: /docs/data-loading
  title: Data Loading
---

## Overview

`ssg` and `isg` pages are rendered once and shared by every visitor. That is what
makes them fast, and it is also why they cannot say "Signed in as Ada" or show
Ada's cart count. Before regions, the options were to make the whole route `ssr`
and give up the cache, or to fetch the personal bit from an island by hand.

A **request-time region** is the first-class version of that personal bit:

- It lives in `src/regions/` and is used as plain JSX in any page or shell.
- Its optional `loader` runs **per request**, after the page route's middleware,
  with the visitor's cookies and the `context` that middleware produced.
- On a cached page the document carries a `fallback`; the browser swaps in the
  region's HTML after load. On an `ssr` page it is rendered inline, with no
  extra request.

```tsx [src/regions/CartCount.tsx]
import { useRegionData, type RegionLoaderArgs, type RegionProps } from "@pracht/core";
import { cartCount } from "../server/cart.ts";

export async function loader({ context, signal }: RegionLoaderArgs) {
  if (!context.user) return { count: 0 };
  return { count: await cartCount(context.user.id, { signal }) };
}

export default function CartCount({ label }: { label: string } & RegionProps) {
  const { count } = useRegionData<typeof loader>();
  return (
    <a href="/cart">
      {label} ({count})
    </a>
  );
}
```

```tsx [src/shells/public.tsx]
import CartCount from "../regions/CartCount.tsx";

export function Shell({ children }: ShellProps) {
  return (
    <>
      <header>
        <CartCount label="Cart" fallback={<a href="/cart">Cart</a>} />
      </header>
      <main>{children}</main>
    </>
  );
}
```

Every route using that shell can stay `ssg` or `isg`. Their HTML is identical for
every visitor; only the cart link changes.

---

## Authoring

Every module in `src/regions/` (configurable with `pracht({ regionsDir })`) is a
region. Its **default export** is the component, and an optional **`loader`**
export fetches its data.

| Export    | Receives                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------- |
| `loader`  | `RegionLoaderArgs`: the page's `request`, `url`, `params`, `route`, `signal`, the middleware `context`, and `props` |
| `default` | The props the page passed. Read the loader's return value with `useRegionData<typeof loader>()` |

At the call site a region takes JSON-serializable props plus one
framework-owned prop, `fallback`, typed through `RegionProps`:

```tsx
<CartCount label="Cart" fallback={<a href="/cart">Cart</a>} />
```

`fallback` is what a cached page shows until the region arrives, and what any
page shows if the region cannot render. It never reaches your component.

Regions cannot receive children, and their props follow the same rules as
[island props](/docs/islands#props-and-children): strings, finite numbers,
booleans, `null`, arrays, and plain objects. A loader value can be anything —
it is used only to render on the server.

A loader may return or throw a `Response` (for example `redirect()`). A region
has no document to redirect, so it keeps its fallback.

---

## How Each Page Renders a Region

| Page                                  | What the document contains                  | Region data                     |
| ------------------------------------- | ------------------------------------------- | ------------------------------- |
| `render: "ssr"`                       | The region's HTML, inline                   | Loaded during the page request  |
| `render: "ssg"` / `"isg"`             | `<pracht-region pending>` with the fallback | Fetched after load              |
| `ssr` with `streaming: true`          | The fallback, like a cached page            | Fetched after load              |
| Client navigation (full hydration)    | —                                           | Fetched when the region mounts  |

On an `ssr` page every region on the page loads concurrently once the page has
rendered, so regions do not add a request, and do not queue behind each other.

The hydration mode decides what fills a pending region:

- **`hydration: "none"`** — a tiny swap script (about 1.3 KB gzip, no Preact) is
  the only JavaScript on the page, and only on pages that rendered a pending
  region.
- **`hydration: "islands"`** — the same swap script. Islands inside a region
  hydrate once its HTML is in the page.
- **`hydration: "full"`** — the region's client module is a placeholder
  component that fetches the HTML itself. The region's markup is an opaque
  subtree: hydration and re-renders leave it alone, so it cannot cause a
  hydration mismatch. Islands inside a region stay static HTML on these pages.

A region's code and its loader never reach the browser: its client module is
the placeholder, plus any stylesheets it imports.

---

## Request Context

On a cached page, the browser requests the region from
`GET /__pracht/region` with the page path, the region, and its props. That
endpoint:

1. matches the page path against your routes,
2. runs **that route's middleware** with a request whose URL is the page's and
   whose headers — cookies included — are the visitor's,
3. runs the region loader and renders the region.

So a session middleware on the page's route sets `context.user` for the region
exactly as it would for an `ssr` render of the page.

If middleware or the loader answers with a `Response` — a login redirect, a
`401` — the endpoint answers `204` and the page keeps the fallback.

---

## Security

The region endpoint is a public server surface, like an API route. Two things
about it are caller-controlled:

- **Props are untrusted input.** On a cached page they travel in the region
  request's query string. Treat them like query parameters: validate them, and
  never let a prop decide *whose* data to load. Derive identity from `context`.
- **The page path is chosen by the caller**, so the middleware that runs is the
  middleware of whichever route that path matches. Use middleware to build
  `context`, and check authorization in the region loader itself:

```ts
export async function loader({ context }: RegionLoaderArgs) {
  if (!context.user) return { orders: [] }; // not middleware's job alone
  return { orders: await recentOrders(context.user.id) };
}
```

Region props are not signed. A signature would prove the props came from a page
render, but on a cached page that render is shared by every visitor — the props
carry nothing that identifies the visitor, so signing them would not make them
safe to authorize with.

The endpoint answers only `GET` requests that send `x-pracht-region: 1`, a header
a cross-site page cannot attach without a CORS preflight the endpoint never
grants. Keep region loaders free of side effects, like any `GET` handler.

Every region response is `Cache-Control: private, no-store`, whatever the
middleware set. No adapter's ISG or edge cache stores it, and the document
around it stays cacheable.

---

## Errors

A region can never fail its page:

- On an `ssr` page, a failing loader or render is reported through the error
  hook (`onRouteError`, logged by default) and the page renders the fallback in
  its place.
- On a cached page, the endpoint reports the failure and answers `500`; the
  swap script leaves the fallback in place.
- Aborted requests stop the loader through `signal`, as with route loaders.

Failures are attributed to the region file in logs and in the dev server.

---

## Content Security Policy

The swap script is an external module script served from your origin, like the
islands bootstrap, so the [starter policy](/docs/recipes-csp)'s
`script-src 'self'` covers it with no nonce or hash — which matters, because a
shared SSG document cannot carry a per-request nonce. It calls the endpoint with
`fetch`, covered by `connect-src 'self'`.

---

## Deployment

Regions need a server to answer the endpoint, so the Node, Cloudflare, Netlify,
and Vercel adapters support them and the static adapter does not: rendering a
region on a page prerendered for `@pracht/adapter-static` fails the build with
a clear error. Render per-visitor content from an island instead there.

`pracht build --analyze` does not attribute the swap script to routes; it is
loaded only by pages that actually render a pending region.
