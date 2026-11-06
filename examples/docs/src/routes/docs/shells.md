---
title: Shells
lead: Layouts that wrap routes. The manifest assigns them, so routes can share a shell without sharing a URL prefix.
---

## Define a shell

Create a module in `src/shells/` that exports a `Shell` component and renders
`children`:

```tsx [src/shells/app.tsx]
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <nav class="sidebar">
        <a href="/dashboard">Dashboard</a>
        <a href="/settings">Settings</a>
      </nav>
      <main>{children}</main>
    </div>
  );
}
```

Every other export is optional:

| Export          | Purpose                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `loader`        | [Shell data](#shell-data) read with `useShellData()`                                        |
| `Loading`       | Rendered inside the shell while an [SPA route](/docs/rendering#spa--single-page-application) loads |
| `ErrorBoundary` | [Fallback](#shell-error-boundary) for routes without their own                              |
| `head`          | [Default head metadata](#shell-head-metadata)                                               |
| `headers`       | [Default document headers](#shell-document-headers)                                         |
| `serverIslands` | [Server islands](/docs/server-islands) the shell renders                                    |

## Assigning shells

Register shells by name in `defineApp`, then reference them from routes or
groups:

```ts [src/routes.ts]
export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  routes: [
    // Per-route
    route("/", "./routes/home.tsx", { shell: "public" }),

    // Per-group — all children inherit
    group({ shell: "app" }, [
      route("/dashboard", "./routes/dashboard.tsx"),
      route("/settings", "./routes/settings.tsx"),
    ]),
  ],
});
```

A client navigation between two routes with the same shell keeps the shell
mounted and re-renders only the route. A navigation to a route with another
shell re-renders the whole tree.

With the pages router, shells come from
[`_app.tsx` files](/docs/routing#shells-via-apptsx) instead.

## Shell data

Export a `loader` from a shell to load data every page in it shows, such as the
signed-in user, once instead of in every route. Read it with `useShellData()`:

```tsx [src/shells/app.tsx]
import { useShellData, type LoaderArgs, type ShellProps } from "@pracht/core";

export async function loader({ context }: LoaderArgs) {
  return { user: await getUser(context.session) };
}

export function Shell({ children }: ShellProps) {
  const shell = useShellData<typeof loader>();
  return (
    <div class="app-layout">
      <nav class="sidebar">{shell?.user.name}</nav>
      <main>{children}</main>
    </div>
  );
}
```

Routes inside the shell read the same value. After
[`pracht typegen`](/docs/routing#typed-routes-and-links), pass the shell name to
type it; a name the route does not render under throws:

```tsx [src/routes/dashboard.tsx]
export function Component() {
  const shell = useShellData("app");
  return <h1>Welcome back, {shell?.user.name}</h1>;
}
```

A shell loader gets the same `LoaderArgs` as a
[route loader](/docs/data-loading#loaders), runs after middleware alongside it,
and handles `redirect()`, `notFound()`, and errors the same way.

Client navigations within the shell keep its data without running the shell
loader again; entering another shell loads that shell's data.
`useRevalidate()`, capability calls, and a `<Form>` that redirects refresh it.

> [!WARNING]
> A shell loader is not an access check, because navigations inside the shell
> skip it. Protect routes with [middleware](/docs/middleware).

`useShellData()` returns `undefined` when the shell has no loader, in an SPA
route's loading state, and in an error boundary shown because the shell loader
failed. Islands and `hydration: "none"` pages get shell data on the server only.

## Shell head metadata

Export `head` from a shell to set site-wide defaults such as the title, icons,
and `og:site_name`. Route `head()` values override the shell's `title` and
append to its `meta` and `link` arrays. See
[Shell-level defaults](/docs/data-loading#shell-level-defaults) for the merge
rules and [Head metadata](/docs/data-loading#head-metadata) for every field.

## Shell document headers

Export `headers` from a shell to add HTTP headers to every page document in it:

```ts [src/shells/app.tsx]
export function headers() {
  return {
    "content-security-policy": "default-src 'self'",
  };
}
```

Route `headers` exports merge with the shell's and win on a name clash. The
headers apply to HTML documents, including prerendered SSG and ISG pages, but
not to API routes or route-state JSON.

## Shell error boundary

Export `ErrorBoundary` from a shell to render a shared fallback for routes that
do not define their own:

```tsx [src/shells/app.tsx]
import type { ErrorBoundaryProps } from "@pracht/core";

export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Something went wrong: {error.message}</p>;
}
```

A route's own `ErrorBoundary` takes precedence.

## The app root

Register an app root with `defineApp({ root })` for client infrastructure that
must survive a navigation across shells, such as a query cache or a store. The
root renders above every shell, on the server and in the browser, and never
remounts.

```ts [src/routes.ts]
export const app = defineApp({
  root: "./root.tsx",
  shells: { app: "./shells/app.tsx" },
  routes: [/* … */],
});
```

Every export is optional:

```tsx [src/root.tsx]
import { createContext } from "preact";
import type { RootProps } from "@pracht/core";

type Store = { items: Map<string, unknown> };
export const StoreContext = createContext<Store | null>(null);

// Once per server request, before any loader, and once when the browser boots.
export function setup(): Store {
  return { items: new Map() };
}

// Wraps every shell. Must render `children`.
export function Root({ state, children }: RootProps<Store>) {
  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}

// Server: a JSON snapshot for the browser, or undefined to send nothing.
export function dehydrate(store: Store) {
  return store.items.size > 0 ? Object.fromEntries(store.items) : undefined;
}

// Browser: apply a snapshot, before hydration and on every route-state
// response (navigations, prefetches, revalidations).
export function hydrate(store: Store, snapshot: unknown) {
  for (const [key, value] of Object.entries(snapshot as object)) store.items.set(key, value);
}
```

Loaders read the request's state as `args.root`, typed by `pracht typegen`.
What a loader puts into it reaches the browser with the page and with every
client navigation; what the server render adds reaches it with the page.
[`@pracht/query`](/docs/recipes/tanstack-query) is built on this.

Request-dependent data still comes from loaders, and layout data from a
[shell loader](#shell-data). Islands render without the app root, on the
server too, so pass them what they need as props. An app without a root ships
none of this code. With the [pages router](/docs/routing#file-conventions), the
root is `pages/_root.tsx`.

> [!WARNING]
> The root module is bundled for the browser, so keep secrets in middleware and
> loaders. Only `dehydrate` is left out of the browser bundle, together with the
> imports only it uses, so it may read server-only modules. If other root code
> calls or re-exports `dehydrate`, the whole module ships.
