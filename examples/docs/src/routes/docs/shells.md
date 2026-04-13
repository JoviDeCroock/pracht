---
title: Shells
lead: Layout wrappers that surround route content. Shells are decoupled from URL structure — a flat route like <code>/settings</code> can share a shell with <code>/dashboard</code> without nesting.
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
