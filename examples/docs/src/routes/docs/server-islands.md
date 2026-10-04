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
cannot say "Signed in as Ada" or show Ada's cart count. A server island renders
that personal part per request while the rest of the page stays cached.

```tsx [src/server-islands/CartCount.tsx]
import {
  useServerIslandData,
  type ServerIslandLoaderArgs,
  type ServerIslandProps,
} from "@pracht/core";
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

Import it into any page or shell, list it in that module's `serverIslands`
export, and use it as plain JSX with a `fallback`:

```tsx [src/shells/public.tsx]
import CartCount from "../server-islands/CartCount.tsx";

export const serverIslands = [CartCount];

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

Every module in `src/server-islands/` (configurable with
`pracht({ serverIslandsDir })`) is a server island, so keep helper modules
elsewhere. The **default export** is the component. The optional **`loader`**
receives the page's `request`, `url`, `params`, `signal`, the `context` your
middleware built, the [app root](/docs/shells#the-app-root) state as `root`, and the server
island's `props`. Read its return value with
`useServerIslandData<typeof loader>()`.

A route or shell lists every server island it renders in
`export const serverIslands = [...]`, including ones rendered by components it
uses. The shell's list covers every route under it. Rendering a server island
the page does not list fails the render with an error naming the module to add
it to. A server island rendered inside another server island needs no listing.

`fallback` is what the page shows until the server island arrives. The page
keeps it when the server island fails, or when middleware or the loader answers
with a `Response` such as `redirect()`. It never reaches your component.

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

On an `ssr` page, the server island loaders run at the same time, and the
response waits for all of them, so the slowest loader decides when the page
arrives. With `streaming: true`, the page is sent without waiting and its server
islands are fetched after load.

On `hydration: "none"` and `"islands"` pages, a small script (about 1.3 KB
gzip, no Preact) fills the server island, and only pages that render a pending
server island load it. Islands inside a server island hydrate once its HTML is
in place. A server island passed to an island as children is fetched when the
island first shows those children. With
[`islandsNavigation`](/docs/islands#client-side-navigation-between-islands-pages),
a swapped-in page fills its server islands the same way, and an island that
stays mounted across the swap keeps the server island HTML it already has.

On `hydration: "full"` pages, the server island's markup is left alone by
hydration and re-renders, so it cannot cause a hydration mismatch. It fetches
fresh HTML after `useRevalidate()`, a successful `<Form>` submission, or a
capability call that changes data, so a cart count follows the cart. Islands
inside a server island stay static HTML on these pages.

A server island's code and its loader never reach the browser. Only the
stylesheets it imports do.

---

## Security

A server island runs with the middleware of the page that renders it, and the
browser asks for it with the page path and props in a URL any caller can edit.
**Server island props are untrusted input: authorize from `context` inside the
loader**, as the `if (!context.user)` check above does.

A server island runs only for pages whose route or shell lists it, under that
page's middleware, but the list is not an authorization check. Anyone who passes
a page's middleware can request every server island that page lists, including
one it renders only conditionally, such as `{isAdmin && <AdminStats />}`. A
loader that returns private data checks `context` itself.

Server island responses are always `Cache-Control: private, no-store`, so the
page around them stays cacheable.

---

## Errors and Deployment

A failing server island never fails its page. The page shows the fallback, and
the error goes to your `onRouteError` hook with the server island file named.

Server islands need a server, so they work on the Node, Cloudflare, Netlify,
and Vercel adapters. With `@pracht/adapter-static`, a prerendered page that
renders a server island fails the build. Load per-visitor content from an
island there instead.
