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

The Vite plugin transforms import functions to strings at build/dev time, so both produce identical behavior when the app runs through `@pracht/vite-plugin`. Direct framework-only tests/scripts should use string refs or run the same transform.

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
  prefetch?: "none" | "hover" | "viewport" | "intent"; // JS prefetch strategy
  speculation?: "prefetch" | "prerender" | { mode; eagerness };
}
```

See [Speculation Rules](#speculation-rules) for `speculation` semantics and how
it composes with the JS-based `prefetch` strategy.

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

## Typed Routes and Links

Generate a type-safe route map from the same resolved app graph used by
`pracht inspect routes --json`:

```bash
pracht typegen
```

This writes `src/pracht-routes.d.ts` for module augmentation and
`src/pracht-routes.ts` for a runtime `href()` helper. Route ids come from
explicit `id` fields and fall back to generated ids such as `index`,
`blog-slug`, or `docs-splat`.

```tsx
import { Link, useNavigate } from "@pracht/core";
import { href } from "../pracht-routes";

export function ProductActions({ id }: { id: string }) {
  const navigate = useNavigate();

  return (
    <>
      <Link route="product" params={{ id }} search={{ ref: "home" }}>
        View product
      </Link>
      <button onClick={() => void navigate({ route: "product", params: { id } })}>
        Open product
      </button>
      <a href={href("product", { params: { id }, search: { tab: "details" } })}>
        Details
      </a>
    </>
  );
}
```

Generated types infer required params from `:param`, `*`, and `:name*`
segments, so missing or extra params fail at compile time. Search params are
currently typed as `SearchParamsInput` (`string`, `URLSearchParams`, or an
object of primitive values/arrays); route-specific search schemas can be added
later through route metadata without changing the runtime helper shape.

Use `pracht typegen --check` in CI to fail when generated route files are stale.

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

Shells can also export `ErrorBoundary` to provide a shared fallback for routes
inside that shell. A route-level `ErrorBoundary` takes precedence when both are
present.

---

## Middleware

Middleware wraps the rest of the request — loaders, API handlers, and any
inner middleware — using a `next()` function. It can redirect, mutate
context, short-circuit with a custom Response, or wrap the inner handler in
`try / catch / finally`.

```typescript
// src/middleware/auth.ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Calling `await next()` runs the rest of the chain (and the loader/handler)
and resolves to the final `Response`. Middleware that returns without
calling `next()` short-circuits the request — the loader/handler never
runs.

### Mutating context

Middleware can read and mutate `args.context` directly. Earlier middleware
sets values, later middleware (and the loader/API handler) sees them on the
same object:

```ts
export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  (context as { user?: User }).user = await getSession(request);
  return next();
};
```

### try / catch / finally

Because middleware wraps the handler, request-scoped logging, tracing, and
timing all live in a single middleware:

```ts
export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  const span = startSpan({ url: request.url });
  let response: Response | undefined;
  try {
    response = await next();
    return response;
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    span.end({ status: response?.status ?? 500 });
  }
};
```

### Applying middleware

Apply middleware to routes or groups:

```typescript
group({ middleware: ["auth"] }, [route("/dashboard", () => import("./routes/dashboard.tsx"))]);
```

Middleware from groups stacks — a route inside a group with `["auth"]` that also
specifies `middleware: ["rateLimit"]` will run both `auth` then `rateLimit`.

Client-side navigations honor same-origin middleware redirects too. If a redirect
lands on the page the user is already on, the router treats it as a no-op
instead of forcing a reload loop.

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
| `pages/guide.mdx`       | `/guide`               |
| `pages/docs/intro.md`   | `/docs/intro`          |
| `pages/_app.tsx`        | _(shell, not a route)_ |
| `pages/_anything.tsx`   | _(ignored)_            |

Markdown and MDX pages are routed the same way as `.tsx` pages. If you want to
render `.mdx` files, add the corresponding Vite transform plugin such as
`@mdx-js/rollup` alongside `pracht()`.

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

During `pracht dev`, resolved routes take precedence over filename heuristics.
That means URLs such as `/blog/release-1.2.3`, `/blog/openapi.json`, and
`/@alice` still render through the framework when they exist as routes. Only
Vite's reserved dev-internal paths are bypassed directly.

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

---

## Speculation Rules

Per-route opt-in for the browser-native [Speculation Rules API]. When set,
pracht emits a single `<script type="speculationrules">` block in the SSR/SSG
HTML that lists every opted-in route as a URLPattern under `href_matches`.

```typescript
defineApp({
  routes: [
    // Browser fetches the HTML on intent (default eagerness "moderate").
    route("/", () => import("./routes/home.tsx"), { speculation: "prefetch" }),

    // Browser fully prerenders in the background (default "conservative").
    // The SPA click handler skips this route so the browser activates the
    // prerendered document on click — instant page swap.
    route("/pricing", () => import("./routes/pricing.tsx"), {
      speculation: "prerender",
    }),

    // Group inheritance + per-route override
    group({ pathPrefix: "/docs", speculation: "prefetch" }, [
      route("/intro", () => import("./routes/docs/intro.tsx")),
      route("/heavy", () => import("./routes/docs/heavy.tsx"), {
        speculation: { mode: "prerender", eagerness: "moderate" },
      }),
    ]),
  ],
});
```

### How it composes with `prefetch`

`prefetch` (`"hover" | "viewport" | "intent"`) controls the framework's JS-side
prefetch — it warms the route-state JSON cache and route module imports so
SPA navigation completes without a network round-trip.

`speculation` is the browser-side analogue. It is most useful for:

1. **`prerender` on landing/marketing pages** — clicks become instant by
   activating an already-rendered document.
2. **`prefetch` for full-page navigations and middle-click / new-tab opens** —
   the browser fills its HTTP cache with the page HTML.

Routes flagged for `prerender` are excluded from JS hover-prefetch to avoid
double-fetching. Set both fields explicitly when you want JS prefetch to keep
running alongside speculation `prefetch`.

### Browser support

Chromium-based browsers (Chrome 109+, Edge). Firefox and Safari ignore the
script — the JS `prefetch` strategy continues to work as the cross-browser
fallback.

[Speculation Rules API]: https://developer.mozilla.org/docs/Web/API/Speculation_Rules_API
