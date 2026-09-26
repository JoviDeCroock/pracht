---
title: Shells
lead: Layout wrappers that surround route content. Shells are decoupled from URL structure — a flat route like `/settings` can share a shell with `/dashboard` without nesting.
breadcrumb: Shells
prev:
  href: /docs/middleware
  title: Middleware
next:
  href: /docs/styling
  title: Styling
---

## Defining a Shell

Shell modules live in `src/shells/` and export a `Shell` component:

```ts [src/shells/app.tsx]
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

---

## Shell Data

Data every page in a shell needs — the signed-in user in the nav, an unread count in the header — belongs to the shell, not to each route. A shell exports `loader(args)` for it and reads the result with `useShellData()`:

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

Routes rendered inside the shell read the same value, without loading it themselves:

```tsx [src/routes/dashboard.tsx]
export function Component() {
  const shell = useShellData("app");
  return <h1>Welcome back, {shell?.user.name}</h1>;
}
```

With [typed routes](/docs/routing#typed-routes-and-links), `pracht typegen` registers every shell a route renders under, so `useShellData("app")` is typed from the shell's loader. Naming a shell the active route does not render under throws. Without typegen, pass the loader type instead: `useShellData<typeof loader>()`. In the pages router, an `_app.tsx` shell exports `loader` the same way.

A shell loader behaves like a [route loader](/docs/data-loading#loaders):

- It receives the same `LoaderArgs` — `request`, `params`, the `context` middleware prepared, `signal`, `url`, `route` (the matched route) — and runs on the server only; `loader` is stripped from the browser copy of the shell.
- It runs after middleware, **concurrently** with the route loader.
- `throw redirect(...)`, `notFound()`, a returned or thrown `Response`, and errors take the same paths as they do from a route loader: redirects, the not-found page, status codes, and the route or shell `ErrorBoundary`. When both loaders fail or answer with a `Response`, the shell's outcome wins — it wraps the route.
- `defer()` values in shell data are resolved before the response; shell data never streams.

### Across navigations

Shell data outlives the route that loaded it. A client navigation between two routes of the **same shell** keeps the shell data on screen: the route-state request carries an `x-pracht-shell-data: <shell>` header, the server skips the shell loader, and only the route's data comes back. Entering a **different shell** fetches that shell's data with the route state. Prefetching follows the same rule.

`useRevalidate()`, a successful non-`read` [capability](/docs/capabilities) call, `<Form capability>`, and the navigation after a `<Form>` redirect refresh shell data along with route data.

> [!WARNING]
> A shell loader is not an authorization boundary. A client that already holds the shell's data asks the server to skip its loader, so a redirect in a shell loader does not protect the routes inside the shell. Gate access in [middleware](/docs/middleware).

### Render modes

| Route | Shell data |
| --- | --- |
| SSR | Loaded per request, rendered into the HTML and the hydration state |
| SSG / ISG | Loaded at build (or regeneration) time and baked into the page and its route state |
| SPA | The loading state renders the shell **without** its data; it arrives with the route's data in the route-state request |
| `hydration: "islands"` / `"none"` | Rendered on the server only; islands receive props, not hooks |

`useShellData()` returns `undefined` whenever the shell renders without its data — a shell with no loader, the SPA loading state, or an `ErrorBoundary` rendered after the shell loader itself failed — so read it defensively in the shell. Shell `head()` and `headers()` do not receive shell data. A static export rejects SPA routes whose shell has a loader, as it rejects SPA route loaders: there is no server to run them.

---

## Shell Head Metadata

Shells can contribute to `<head>` by exporting a `head` function. Shell metadata merges with route-level metadata:

```ts
// Shell exports head() for shared metadata
export function head() {
  return {
    title: "My App",
    meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  };
}

// Route can override title, arrays are concatenated
export function head() {
  return { title: "Dashboard — My App" };
}
```

> [!NOTE]
> Route `title` overrides shell `title`. Array fields like `meta` and `link` are merged.

---

## Shell Document Headers

Shells can contribute HTTP headers to page documents by exporting a `headers` function:

```ts
export function headers() {
  return {
    "content-security-policy": "default-src 'self'",
  };
}
```

Shell headers merge with route-level `headers` exports. Route headers override shell headers with the same name. These headers apply to HTML document responses and prerendered SSG/ISG HTML, not API routes or route-state JSON fetches.

---

## Shell Error Boundary

Shells can export `ErrorBoundary` to provide a shared fallback for routes that do not define their own boundary:

```tsx
import type { ErrorBoundaryProps } from "@pracht/core";

export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Something went wrong: {error.message}</p>;
}
```

Route-level `ErrorBoundary` exports take precedence over the shell boundary.

---

## Assigning Shells

Register shells by name in `defineApp`, then reference them in routes or groups:

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

---

## Client-Side Navigation

When navigating between routes that share the same shell, pracht preserves the shell and only re-renders the route content, and keeps the [shell's data](#shell-data) instead of loading it again. When crossing shell boundaries, the full page tree is re-rendered with the new shell's data.
