---
title: Routing
lead: pracht uses a hybrid routing model: route modules live as files by convention, but their wiring — shells, middleware, render modes, and URL patterns — is declared explicitly in a single <code>src/routes.ts</code> manifest.
breadcrumb: Routing
prev:
  href: /docs/why-pracht
  title: Why Pracht?
next:
  href: /docs/rendering
  title: Rendering Modes
---

## Route Manifest

The manifest is the central source of truth for your app's routing. Define it in `src/routes.ts` using `defineApp`, `route`, and `group`:

```ts [src/routes.ts]
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

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
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/settings", "./routes/settings.tsx", { render: "spa" }),
    ]),
  ],
});
```

### Why explicit over file-based?

File-based routing (Next.js, SvelteKit) couples URL structure to directory structure. This forces awkward nesting for layout groups and makes middleware assignment implicit. pracht's hybrid approach:

- Route modules live in `src/routes/` (discoverable by convention)
- Route _wiring_ is explicit in `src/routes.ts` (auditable, type-checked)
- Shells and middleware are named references (reusable across groups)
- URL structure is independent of file system layout

---

## API Reference

### defineApp(config)

| Field      | Type                                   | Description                                                   |
| ---------- | -------------------------------------- | ------------------------------------------------------------- |
| shells     | Record\<string, string\>               | Named shell modules — key is the name, value is the file path |
| middleware | Record\<string, string\>               | Named middleware modules                                      |
| routes     | (RouteDefinition \| GroupDefinition)[] | The route tree                                                |

### route(path, file, meta?)

| Param | Type      | Description                                           |
| ----- | --------- | ----------------------------------------------------- |
| path  | string    | URL pattern, e.g. `/blog/:slug`                       |
| file  | string    | Relative path to the route module                     |
| meta  | RouteMeta | Optional render mode, shell, middleware, revalidation |

### group(meta, routes)

Groups routes with shared configuration. Properties cascade to children; a route's own meta overrides the group's.

| Param  | Type              | Description                                           |
| ------ | ----------------- | ----------------------------------------------------- |
| meta   | GroupMeta         | Shell, middleware, render mode, pathPrefix to inherit |
| routes | RouteDefinition[] | Routes in this group                                  |

---

## Path Patterns

### Static paths

```ts
route("/about", "./routes/about.tsx");
// Matches /about exactly
```

### Dynamic segments

```ts
route("/blog/:slug", "./routes/blog-post.tsx");
// /blog/hello-world → params.slug = "hello-world"

route("/users/:userId/posts/:postId", "./routes/user-post.tsx");
// Multiple dynamic segments
```

### Catch-all segments

```ts
route("/docs/*", "./routes/docs.tsx");
// Matches /docs/a/b/c — catch-all available in params
```

---

## Shells

Shells are Preact layout components that wrap route content. They are **decoupled from URL structure** — a flat URL like `/settings` can use the `app` shell without nesting under `/app/settings`.

```ts [src/shells/app.tsx]
import type { ShellProps } from "@pracht/core";

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

> [!NOTE]
> Shell head metadata merges with route-level head. Route head takes precedence for `title`. Arrays like `meta` and `link` are concatenated.

Shell document headers merge with route-level `headers` exports. Route headers take precedence for matching names. These headers apply to HTML document responses, including prerendered SSG/ISG HTML, but not API routes or route-state JSON fetches.

---

## Middleware

Middleware runs server-side before the loader. It can redirect, modify context, or throw errors.

```ts [src/middleware/auth.ts]
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return { redirect: "/login" };
  // Return void to continue to the loader
};
```

Middleware stacks within groups — a route inside a group with `["auth"]` that also declares `["rateLimit"]` runs both in order.

---

## Path Prefix Groups

Groups can add a URL prefix to all child routes, keeping route files flat while grouping URLs logically:

```ts
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", "./routes/admin/index.tsx"), // → /admin
  route("/users", "./routes/admin/users.tsx"), // → /admin/users
  route("/settings", "./routes/admin/settings.tsx"), // → /admin/settings
]);
```

---

## Pages Router (Auto-Discovery)

For projects that prefer file-system routing — especially when migrating from Next.js — pracht offers an optional pages-based routing mode. Instead of writing a route manifest, set `pagesDir` and pracht auto-discovers routes from the file system.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

When `pagesDir` is set, the `appFile` option is ignored. The plugin scans the pages directory and generates the route manifest automatically.

### File Conventions

| File                    | Route                                       |
| ----------------------- | ------------------------------------------- |
| `pages/index.tsx`       | `/`                                         |
| `pages/about.tsx`       | `/about`                                    |
| `pages/blog/index.tsx`  | `/blog`                                     |
| `pages/blog/[slug].tsx` | `/blog/:slug`                               |
| `pages/[...path].tsx`   | `/*`                                        |
| `pages/_app.tsx`        | _(shell, not a route)_                      |
| `pages/_anything.tsx`   | _(ignored — underscore prefix is reserved)_ |

### Shell via `_app.tsx`

If `pages/_app.tsx` exists, it is registered as a shell named `"pages"` and all discovered routes are automatically wrapped in it:

```tsx [src/pages/_app.tsx]
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

Page files can export a `RENDER_MODE` constant to override the rendering strategy:

```tsx [src/pages/about.tsx]
export const RENDER_MODE = "ssg";

export default function About() {
  return <div>About us</div>;
}
```

Valid values: `"ssr"` | `"ssg"` | `"isg"` | `"spa"`. The default is `"ssr"`, overridable globally via `pagesDefaultRender`:

```ts [vite.config.ts]
pracht({ pagesDir: "/src/pages", pagesDefaultRender: "ssg" });
```

### Route Priority

Routes are sorted: static routes first, then dynamic (`:param`), then catch-all (`*`). This matches Next.js resolution order.

### Ejecting to Explicit Manifest

When you outgrow auto-discovery and want full manifest control, eject with a one-time codegen:

```ts
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
});
```

Then remove `pagesDir` from your pracht config. The generated `src/routes.ts` is a standard manifest you can customize freely.
