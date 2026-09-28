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

An `ssg` or `isg` page is rendered once and shared by every visitor, so it
cannot say "Signed in as Ada" or show Ada's cart count. A region renders that
personal part per request while the rest of the page stays cached.

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

Use it as plain JSX in any page or shell, with a `fallback`:

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

Every route using that shell can stay `ssg` or `isg`. Their HTML is the same for
every visitor, and each visitor sees their own cart count.

---

## Authoring

Every module in `src/regions/` (configurable with `pracht({ regionsDir })`) is a
region, so keep helper modules elsewhere. The **default export** is the
component. The optional **`loader`** receives the page's `request`, `url`,
`params`, `signal`, the `context` your middleware built, and the region's
`props`. Read its return value with `useRegionData<typeof loader>()`.

`fallback` is what the page shows until the region arrives. The page keeps it
when the region fails, or when middleware or the loader answers with a
`Response` such as `redirect()`. It never reaches your component.

Regions take no children. Their props follow the rules for
[island props](/docs/islands#props-and-children): strings, finite numbers,
booleans, `null`, arrays, and plain objects. The loader's return value can be
anything, because it is only rendered on the server.

---

## What Visitors See

| Page | The document contains | Then |
| ---- | --------------------- | ---- |
| `render: "ssr"` | The region's HTML | Nothing more to load |
| `render: "ssg"` / `"isg"` | The fallback | The browser fetches the region after load |
| `ssr` with `streaming: true` | The fallback | The browser fetches the region after load |
| Client navigation (full hydration) | The fallback | The region is fetched when it mounts |

On `hydration: "none"` and `"islands"` pages, a small script (about 1.3 KB
gzip, no Preact) fills the region, and only pages that render a pending region
load it. Islands inside a region hydrate once its HTML is in place.

On `hydration: "full"` pages, the region's markup is left alone by hydration
and re-renders, so it cannot cause a hydration mismatch. Islands inside a
region stay static HTML on these pages.

A region's code and its loader never reach the browser. Only the stylesheets it
imports do.

---

## Security

A cached page fetches its regions from `GET /__pracht/region`, naming the page
path, the region, and its props, and any caller can send that request for any
page path. **Region props are untrusted input: authorize from `context` inside
the loader**, even when the page that renders the region sits behind auth
middleware, as the `if (!context.user)` check above does.

Region responses are always `Cache-Control: private, no-store`, so the page
around them stays cacheable.

---

## Errors and Deployment

A failing region never fails its page. The page shows the fallback, and the
error goes to your `onRouteError` hook with the region file named.

Regions need a server, so they work on the Node, Cloudflare, Netlify, and Vercel
adapters. With `@pracht/adapter-static`, a prerendered page that renders a
region fails the build. Load per-visitor content from an island there instead.
