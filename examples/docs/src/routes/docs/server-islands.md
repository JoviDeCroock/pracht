---
title: Server islands
lead: Render one part of a cached or prerendered page per request, with the visitor's cookies and middleware context.
---

## Overview

An `ssg` or `isg` page is rendered once and shared by every visitor, so it cannot show "Signed in as Ada" or Ada's cart count. A server island renders that part per request while the rest of the page stays cached.

Create the server island in `src/server-islands/`:

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

Import it into a page or shell, list it in that module's `serverIslands` export, and render it with a `fallback`:

```tsx [src/shells/public.tsx]
import type { ShellProps } from "@pracht/core";
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

Every route using that shell can stay `ssg` or `isg`. The HTML is the same for every visitor, and each visitor sees their own cart count.

## Authoring

Every module in `src/server-islands/` is a server island (change it with `pracht({ serverIslandsDir })`), so keep helpers elsewhere.

| Export | Role |
| ------ | ---- |
| `default` | The component. Read the loader's data with `useServerIslandData<typeof loader>()`. |
| `loader` (optional) | Runs on the server per request. Receives the page's `request`, `url`, `params`, `signal`, the `context` your middleware built, the [app root](/docs/shells#the-app-root) state as `root`, and the server island's `props`. |

Server islands take no children. Their props follow the rules for [island props](/docs/islands#props-and-children); the loader's return value can be anything, because it is only rendered on the server.

### List every server island the page renders

A route or shell lists every server island it renders in `export const serverIslands = [...]`, including ones rendered by components it uses. A shell's list covers every route under it. A server island rendered inside another server island needs no listing.

Rendering one the page does not list fails the render (on an `spa` route, the dev console warns instead):

```text
Server island "CartCount" (src/server-islands/CartCount.tsx) is rendered by a page that does not list it. Add it to `export const serverIslands = [...]` in the route module, or in the shell module when the shell renders it.
```

### Fallback

`fallback` is what the page shows until the server island arrives. The page keeps it when the server island fails, or when middleware or the loader answers with a `Response` such as `redirect()`. The component never receives it.

## What visitors see

| Page | The document contains | Then |
| ---- | --------------------- | ---- |
| `render: "ssr"` | The server island's HTML | Nothing more to load |
| `render: "ssg"` / `"isg"` | The fallback | The browser fetches the server island after load |
| `ssr` with `streaming: true` | The fallback | The browser fetches the server island after load |
| Client navigation (full hydration) | The fallback | The server island is fetched when it mounts |

On an `ssr` page, the server island loaders run in parallel and the response waits for all of them, so the slowest loader decides when the page arrives. With `streaming: true` the page is sent without waiting.

On `hydration: "none"` and `"islands"` pages, a script of about 1.3 KB gzip (no Preact) fills server islands; only pages with a pending server island load it.

- Islands inside a server island hydrate once its HTML is in place.
- A server island passed to an island as children is fetched when the island first shows them.
- With [`islandsNavigation`](/docs/islands#client-side-navigation-between-islands-pages), a swapped-in page fills its server islands the same way, and an island that stays mounted keeps the server island HTML it has.

On `hydration: "full"` pages, hydration leaves the server island's markup alone, so it cannot cause a hydration mismatch. It fetches fresh HTML after `useRevalidate()`, a successful `<Form>` submission, or a capability call that changes data, so a cart count follows the cart. Islands inside a server island stay static HTML on these pages.

A server island's code and loader never reach the browser; only the stylesheets it imports do.

## Security

A server island runs under the middleware of the page that renders it. The browser requests it with the page path and props in a URL any caller can edit.

**Server island props are untrusted input: authorize from `context` inside the loader**, as the `if (!context.user)` check above does.

The `serverIslands` list is not an authorization check. Anyone who passes a page's middleware can request every server island that page lists, including one it renders only conditionally, such as `{isAdmin && <AdminStats />}`. A loader that returns private data checks `context` itself.

Server island responses are always `Cache-Control: private, no-store`, so the page around them stays cacheable.

## Errors and deployment

A failing server island never fails its page. The page shows the fallback, and the error goes to your `onRouteError` hook with the server island file named.

Server islands need a server: they work on the Node, Cloudflare, Netlify, and Vercel adapters. With `@pracht/adapter-static`, a prerendered page that renders a server island fails the build with:

```text
Server island "CartCount" (src/server-islands/CartCount.tsx) was rendered on a prerendered page, but the static adapter deploys no server to answer server island requests. Render the content client-side from an island instead, or deploy with a server adapter.
```
