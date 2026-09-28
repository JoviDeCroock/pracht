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

Data every page in a shell shows, like the signed-in user in the nav, can load once in the shell instead of in every route. Export a `loader` from the shell and read its result with `useShellData()`:

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

Routes inside the shell read the same value. After [`pracht typegen`](/docs/routing#typed-routes-and-links), pass the shell name to type it; a name the route does not render under throws:

```tsx [src/routes/dashboard.tsx]
export function Component() {
  const shell = useShellData("app");
  return <h1>Welcome back, {shell?.user.name}</h1>;
}
```

A shell loader gets the same `LoaderArgs` as a [route loader](/docs/data-loading#loaders), runs after middleware alongside it, and handles `redirect()`, `notFound()`, and errors the same way. A pages-router `_app.tsx` exports `loader` the same way.

Client navigations between routes of the same shell keep its data on screen without running the shell loader again; entering another shell loads that shell's data. `useRevalidate()`, capability calls, and a `<Form>` that redirects refresh it.

> [!WARNING]
> A shell loader is not an access check, because navigations inside the shell skip it. Protect routes with [middleware](/docs/middleware).

`useShellData()` returns `undefined` when the shell has no loader, in an SPA route's loading state, and in an error boundary shown because the shell loader failed. Islands and `hydration: "none"` pages get shell data on the server only.

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

When navigating between routes that share the same shell, pracht preserves the shell and only re-renders the route content. When crossing shell boundaries, the full page tree is re-rendered.
