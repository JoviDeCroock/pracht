# Routing

Pracht uses hybrid routing: route modules live as files, but wiring is explicit
in a manifest. This gives you file-based discoverability with full control over
shells, middleware, and render modes.

---

## Route Manifest

Define your app's routes in `src/routes.ts`:

```typescript
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: () => import("./shells/public.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
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

Module references accept two forms — both are fully supported:

- **`() => import("./path")`** — enables IDE ctrl+click navigation (recommended)
- **`"./path"`** — plain string, shorter syntax

The vite plugin transforms import functions to strings at build time, so both produce identical runtime behavior.

### `defineApp(config)`

Top-level configuration:

| Field        | Type                                     | Description                                                           |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `shells`     | `Record<string, ModuleRef>`              | Named shell modules — use `() => import("./path")` for IDE navigation |
| `middleware` | `Record<string, ModuleRef>`              | Named middleware modules                                              |
| `routes`     | `(RouteDefinition \| GroupDefinition)[]` | Route tree                                                            |

### `route(path, file, meta?)`

Defines a single route:

| Param  | Type        | Description                                            |
| ------ | ----------- | ------------------------------------------------------ |
| `path` | `string`    | URL pattern (e.g. `/blog/:slug`)                       |
| `file` | `ModuleRef` | Module reference — `() => import("./path")` or string  |
| `meta` | `RouteMeta` | Optional: render mode, shell, middleware, revalidation |

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

// Optional: shell-level document headers
export function headers() {
  return { "content-security-policy": "default-src 'self'" };
}
```

Shell head metadata is merged with route-level head. Route head takes precedence
for conflicting keys (e.g. `title`).

Shell document headers are merged with route-level `headers` exports. Route
headers take precedence for matching names. These headers apply to HTML
document responses, including prerendered SSG/ISG HTML, but not API routes or
route-state JSON fetches.

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

---

## Pages Router (Auto-Discovery)

For projects that prefer file-system routing (especially when migrating from
Next.js), pracht offers an optional pages-based routing mode. Instead of writing
a route manifest in `src/routes.ts`, you set a `pagesDir` option and pracht
auto-discovers routes from the file system.

### Setup

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

When `pagesDir` is set, `appFile` is ignored. The plugin scans the pages
directory and generates the route manifest automatically.

### File Conventions

| File                    | Route                  |
| ----------------------- | ---------------------- |
| `pages/index.tsx`       | `/`                    |
| `pages/about.tsx`       | `/about`               |
| `pages/blog/index.tsx`  | `/blog`                |
| `pages/blog/[slug].tsx` | `/blog/:slug`          |
| `pages/[...path].tsx`   | `/*`                   |
| `pages/_app.tsx`        | _(shell, not a route)_ |
| `pages/_anything.tsx`   | _(ignored)_            |

### Shell via `_app.tsx`

If `pages/_app.tsx` exists, it is registered as a shell named `"pages"` and all
routes are automatically wrapped in it:

```tsx
// src/pages/_app.tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <nav>...</nav>
      <main>{children}</main>
    </div>
  );
}

export function headers() {
  return { "content-security-policy": "default-src 'self'" };
}
```

### Per-Route Render Mode

Page files can export a `RENDER_MODE` constant to set the rendering strategy:

```tsx
// src/pages/about.tsx
export const RENDER_MODE = "ssg";

export default function About() {
  return <div>About us</div>;
}
```

Valid values: `"ssr"` | `"ssg"` | `"isg"` | `"spa"`. The default is `"ssr"`,
overridable globally via `pagesDefaultRender`:

```typescript
pracht({ pagesDir: "/src/pages", pagesDefaultRender: "ssg" });
```

### Route Priority

Routes are sorted: static routes first, then dynamic (`:param`), then catch-all
(`*`). This matches Next.js resolution order and pracht's linear-scan matching.

### HMR Behavior

- **File edit** in pages dir: virtual modules are invalidated (fast update)
- **File add/remove** in pages dir: dev server restarts (new routes need
  new globs)

### Ejecting to Explicit Manifest

To stop using auto-discovery and customize the manifest directly, use the
`generateRoutesFile` export from the plugin:

```typescript
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
});
```

Then remove `pagesDir` from your pracht config. The generated file includes
a header comment explaining how to use it directly.
