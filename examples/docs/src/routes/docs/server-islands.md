---
title: Server Islands
lead: A server island is a small server-rendered part of a page that renders per request, with the visitor's cookies and middleware context, even when the page around it is prerendered and cached for everyone.
breadcrumb: Server Islands
prev:
  href: /docs/islands
  title: Islands
next:
  href: /docs/data-loading
  title: Data Loading
---

## Overview

An `ssg` or `isg` page is rendered once and shared by every visitor, so it
cannot say "Signed in as Ada" or show Ada's cart count. A server island renders that
personal part per request while the rest of the page stays cached.

```tsx [src/server-islands/CartCount.tsx]
import { useServerIslandData, type ServerIslandLoaderArgs, type ServerIslandProps } from "@pracht/core";
import { cartCount } from "../server/cart.ts";

export async function loader({ context, signal }: ServerIslandLoaderArgs) {
  if (!context.user) return { count: 0 };
  return { count: await cartCount(context.user.id, { signal }) };
}

export default function CartCount({ label }: { label: string } & ServerIslandProps) {
  const { count } = useServerIslandData<typeof loader>();
  return (
    <a href="/cart">
      {label} ({count})
    </a>
  );
}
```

Use it as plain JSX in any page or shell, with a `fallback`:

```tsx [src/shells/public.tsx]
import CartCount from "../server-islands/CartCount.tsx";

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

Every module in `src/server-islands/` (configurable with `pracht({ serverIslandsDir })`) is a
server island, so keep helper modules elsewhere. The **default export** is the
component. The optional **`loader`** receives the page's `request`, `url`,
`params`, `signal`, the `context` your middleware built, and the server island's
`props`. Read its return value with `useServerIslandData<typeof loader>()`.

`fallback` is what the page shows until the server island arrives. The page keeps it
when the server island fails, or when middleware or the loader answers with a
`Response` such as `redirect()`. It never reaches your component.

Server islands take no children. Their props follow the rules for
[island props](/docs/islands#props-and-children): strings, finite numbers,
booleans, `null`, arrays, and plain objects. The loader's return value can be
anything, because it is only rendered on the server.

---

## What Visitors See

| Page | The document contains | Then |
| ---- | --------------------- | ---- |
| `render: "ssr"` | The server island's HTML | Nothing more to load |
| `render: "ssg"` / `"isg"` | The fallback | The browser fetches the server island after load |
| `ssr` with `streaming: true` | The fallback | The browser fetches the server island after load |
| Client navigation (full hydration) | The fallback | The server island is fetched when it mounts |

On `hydration: "none"` and `"islands"` pages, a small script (about 1.3 KB
gzip, no Preact) fills the server island, and only pages that render a pending server island
load it. Islands inside a server island hydrate once its HTML is in place.

On `hydration: "full"` pages, the server island's markup is left alone by hydration
and re-renders, so it cannot cause a hydration mismatch. Islands inside a
server island stay static HTML on these pages.

A server island's code and its loader never reach the browser. Only the stylesheets it
imports do.

---

## Security

A cached page fetches its server islands from `GET /__pracht/server-island`, naming the page
path, the server island, and its props, and any caller can send that request for any
page path. **Server island props are untrusted input: authorize from `context` inside
the loader**, even when the page that renders the server island sits behind auth
middleware, as the `if (!context.user)` check above does.

Server island responses are always `Cache-Control: private, no-store`, so the page
around them stays cacheable.

---

## Errors and Deployment

A failing server island never fails its page. The page shows the fallback, and the
error goes to your `onRouteError` hook with the server island file named.

Server islands need a server, so they work on the Node, Cloudflare, Netlify, and Vercel
adapters. With `@pracht/adapter-static`, a prerendered page that renders a
server island fails the build. Load per-visitor content from an island there instead.
