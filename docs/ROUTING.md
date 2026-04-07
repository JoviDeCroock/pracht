# Routing

Viact uses hybrid routing: route modules live as files, but wiring is explicit
in a manifest. This gives you file-based discoverability with full control over
shells, middleware, and render modes.

---

## Route Manifest

Define your app's routes in `src/routes.ts`:

```typescript
import { defineApp, group, route, timeRevalidate } from "viact";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
    ]),
  ],
});
```

### `defineApp(config)`

Top-level configuration:

| Field        | Type                                     | Description                                            |
| ------------ | ---------------------------------------- | ------------------------------------------------------ |
| `shells`     | `Record<string, string>`                 | Named shell modules, keyed by name, value is file path |
| `middleware` | `Record<string, string>`                 | Named middleware modules                               |
| `routes`     | `(RouteDefinition \| GroupDefinition)[]` | Route tree                                             |

### `route(path, component, meta?)`

Defines a single route:

| Param       | Type                     | Description                                            |
| ----------- | ------------------------ | ------------------------------------------------------ |
| `path`      | `string`                 | URL pattern (e.g. `/blog/:slug`)                       |
| `component` | `() => Promise<any>`     | Lazy import function for the route module              |
| `meta`      | `RouteMeta`              | Optional: render mode, shell, middleware, revalidation |

The `component` argument is a dynamic `import()` expression, which gives you IDE
jump-to-definition and TypeScript module resolution. String paths are still
accepted for backward compatibility.

### `group(meta, routes)`

Groups routes with shared configuration:

| Param    | Type                | Description                                           |
| -------- | ------------------- | ----------------------------------------------------- |
| `meta`   | `GroupMeta`         | Shell, middleware, render mode, pathPrefix to inherit |
| `routes` | `RouteDefinition[]` | Routes in this group                                  |

Group properties cascade to children. A route's own meta overrides the group's.

---

## Route Meta

```typescript
interface RouteMeta {
  id?: string; // Explicit route ID (auto-generated if omitted)
  shell?: string; // Named shell from defineApp.shells
  render?: "spa" | "ssr" | "ssg" | "isg";
  middleware?: string[]; // Named middleware from defineApp.middleware
  revalidate?: RouteRevalidate; // ISG revalidation policy
}
```

---

## Path Patterns

### Static paths

```typescript
route("/about", () => import("./routes/about.tsx"));
```

Matches `/about` exactly.

### Dynamic segments

```typescript
route("/blog/:slug", () => import("./routes/blog-post.tsx"));
```

Matches `/blog/hello-world` with `params.slug = "hello-world"`.

Multiple dynamic segments:

```typescript
route("/users/:userId/posts/:postId", () => import("./routes/user-post.tsx"));
```

### Catch-all segments

```typescript
route("/docs/*", () => import("./routes/docs.tsx"));
```

Matches `/docs/a/b/c` — the catch-all value is available in params.

---

## Route Resolution

At build time, the route tree (including groups) is flattened into a linear array
of resolved routes. Each resolved route has all inherited properties applied:

```
group({ shell: "public" }, [
  route("/", () => import("./routes/home.tsx"), { render: "ssg" })
])
```

Resolves to:

```
{
  path: "/",
  file: "./routes/home.tsx",
  shell: "public",
  shellFile: "./shells/public.tsx",
  render: "ssg",
  middleware: [],
}
```

Runtime matching is a linear scan over this flat array. For typical app sizes
(tens to low hundreds of routes) this is effectively instant.

---

## Shells

Shells are Preact components that wrap route content. They are **decoupled from
URL structure** — a flat URL like `/settings` can use the `app` shell without
nesting under `/app/settings`.

```typescript
// src/shells/app.tsx
export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

// Optional: shell-level <head> metadata
export function head() {
  return { title: "My App" };
}
```

Shell head metadata is merged with route-level head. Route head takes precedence
for conflicting keys (e.g. `title`).

---

## Middleware

Middleware runs server-side before the loader. It can redirect, modify context,
or throw errors.

```typescript
// src/middleware/auth.ts
export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return { redirect: "/login" };
  // Returning void continues to the loader
};
```

Apply middleware to routes or groups:

```typescript
group({ middleware: ["auth"] }, [route("/dashboard", () => import("./routes/dashboard.tsx"))]);
```

Middleware from groups stacks — a route inside a group with `["auth"]` that also
specifies `middleware: ["rateLimit"]` will run both `auth` then `rateLimit`.

---

## Path Prefix Groups

Groups can add a URL prefix to all child routes:

```typescript
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", () => import("./routes/admin/index.tsx")), // → /admin
  route("/users", () => import("./routes/admin/users.tsx")), // → /admin/users
]);
```

This keeps route files flat while grouping URLs logically.
