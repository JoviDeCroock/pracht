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

---

## The App Root

A shell is swapped whenever a navigation crosses shells, and everything inside it remounts. For state that has to outlive every navigation — a data cache, a theme, an analytics client — add an app root: `src/root.tsx` (or `.ts`). It renders above every shell, on the server and in the browser, and is never remounted. Every export is optional:

```tsx [src/root.tsx]
import { createContext } from "preact";
import type { RootProps, RootSetupArgs } from "@pracht/core";

export const Theme = createContext("light");

// Once per server request, and once when the browser boots.
export function setup({ request }: RootSetupArgs) {
  return { theme: request?.headers.get("sec-ch-prefers-color-scheme") ?? "light" };
}

// Wraps every shell. Must render `children`.
export function Root({ state, children }: RootProps<ReturnType<typeof setup>>) {
  return <Theme.Provider value={state.theme}>{children}</Theme.Provider>;
}

// Server: what to send to the browser (JSON). Return undefined to send nothing.
export function dehydrate(state: ReturnType<typeof setup>) {
  return { theme: state.theme };
}

// Browser: merge what the server sent, before hydration and after every
// route-state response (navigations, prefetches, revalidations).
export function hydrate(state: ReturnType<typeof setup>, snapshot: unknown) {
  state.theme = (snapshot as { theme: string }).theme;
}
```

Loaders receive the request's state as `args.root`. `dehydrate()` runs after a document renders and after the loader of a client navigation, so whatever the loader or the render put into the state reaches the browser. [`@pracht/query`](/docs/recipes/tanstack-query) is built on exactly this.

On the server, `setup()` runs for each request, so nothing in the state leaks between visitors. Islands routes do not render the app root in the browser, since each island hydrates on its own. An app without a root file ships none of this code. Change the location with the `rootFile` plugin option.
