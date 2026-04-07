# Viact Architecture

This document describes the core architecture, abstractions, and design decisions
behind viact. It serves as the source of truth for contributors and AI agents
working on the framework.

The current repo scaffold and package boundaries are tracked in
[docs/WORKSPACE.md](WORKSPACE.md).

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User Application                      │
│  src/routes.ts    src/routes/    src/shells/    src/api/ │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  packages/framework                      │
│  Route manifest · Router · Server renderer · Client RT   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 packages/vite-plugin                      │
│  Virtual modules · Multi-env build · SSG prerender       │
└──────────────┬───────────────────────┬──────────────────┘
               │                       │
┌──────────────▼────────┐ ┌────────────▼──────────────────┐
│  packages/adapter-*   │ │   packages/cli                 │
│  Node · CF · Vercel   │ │   dev · build · preview        │
└───────────────────────┘ └────────────────────────────────┘
```

---

## Core Abstractions

### 1. Route Manifest (`defineApp`, `route`, `group`)

The route manifest is the central configuration. Users define it in `src/routes.ts`:

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
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/about", "./routes/about.tsx", { render: "ssg" }),
      route("/blog/:slug", "./routes/blog-post.tsx", {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      // Inline style: loader/action exported from the route file
      route("/settings", "./routes/settings.tsx", { render: "spa" }),
      // Separate files style: server code in dedicated files
      route("/dashboard", {
        component: "./routes/dashboard.tsx",
        loader: "./server/dashboard-loader.ts",
        action: "./server/dashboard-action.ts",
        render: "ssr",
      }),
    ]),
  ],
});
```

**Why explicit over file-based?**

Pure file-based routing (Next.js, SvelteKit) couples URL structure to directory
structure. This forces awkward nesting for layout groups and makes middleware
assignment implicit via `_middleware.ts` files. Viact's hybrid approach:

- Route modules live in `src/routes/` (discoverable by convention)
- Route _wiring_ is explicit in `src/routes.ts` (auditable, type-checked)
- Shells and middleware are named references (reusable across groups)
- URL structure is independent of file system layout

### 2. Route Modules

Viact supports two styles for wiring data loading to routes. Both can coexist
in the same app.

#### Style A: Inline (loader/action in the route file)

A route module exports some combination of:

```typescript
// src/routes/dashboard.tsx

// Server: runs on request (SSR) or build (SSG)
export async function loader({ request, params, context, signal }: LoaderArgs) {
  return { user: await getUser(request) };
}

// Server: handles POST/PUT/PATCH/DELETE
export async function action({ request, params, context }: ActionArgs) {
  const form = await request.formData();
  await createProject(form.get("name"));
  return { ok: true, revalidate: ["route:self"] };
}

// Shared: <head> metadata
export function head({ data }: HeadArgs<typeof loader>) {
  return { title: `Dashboard — ${data.user.name}` };
}

// Client + SSR: the page component
export function Component({ data }: RouteComponentProps<typeof loader>) {
  const liveData = useRouteData<typeof loader>();
  return <main>{liveData.user.name}</main>;
}

// Client + SSR: error boundary (optional)
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Something went wrong: {error.message}</p>;
}

// Build: enumerate paths for SSG/ISG prerendering (optional)
export async function prerender(): Promise<string[]> {
  return ["/dashboard"];
}
```

#### Style B: Separate files (server code in dedicated files)

Server-side data functions live in `src/server/` (or any directory configured
via `serverDir`). Route files become pure components with no server code:

```typescript
// src/server/dashboard-loader.ts
export async function loader({ request }: LoaderArgs) {
  return { user: await getUser(request) };
}
```

```typescript
// src/server/dashboard-action.ts
export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  await createProject(form.get("name"));
  return { ok: true, revalidate: ["route:self"] };
}
```

```typescript
// src/routes/dashboard.tsx — pure component, no server code
export function Component({ data }: RouteComponentProps) {
  return <main>{data.user.name}</main>;
}
```

Wired in the manifest via the `RouteConfig` object form:

```typescript
route("/dashboard", {
  component: "./routes/dashboard.tsx",
  loader: "./server/dashboard-loader.ts",
  action: "./server/dashboard-action.ts",
  render: "ssr",
});
```

When a separate file is specified, it takes precedence over inline exports in
the route module.

### 3. Shell Modules

Shells are Preact layout components that wrap route content:

```typescript
// src/shells/public.tsx
import type { ShellProps } from "viact";

export function Shell({ children }: ShellProps) {
  return (
    <div class="layout">
      <nav>...</nav>
      <main>{children}</main>
      <footer>...</footer>
    </div>
  );
}

export function head() {
  return {
    title: "Viact App",
    meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  };
}
```

Shells are decoupled from URLs — a `/dashboard` and `/settings` can share the
`app` shell without being nested under `/app/*`. This avoids the "layout route"
pattern that forces URL structure to mirror component hierarchy.

### 4. Middleware

Server-side functions that run before loaders:

```typescript
// src/middleware/auth.ts
import type { MiddlewareFn } from "viact";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return { redirect: "/login" };
};
```

Middleware is named in the manifest and applied per route or group. It can
redirect, set context, or throw errors.

### 5. Module Registry

The Vite plugin generates a module registry at build time using `import.meta.glob()`.
This maps normalized file paths to lazy module importers:

```typescript
// Generated virtual module
const routeModules = {
  "./routes/home.tsx": () => import("./routes/home.tsx"),
  "./routes/dashboard.tsx": () => import("./routes/dashboard.tsx"),
};
```

This avoids hand-maintained import maps and enables code splitting — each route
is a separate chunk loaded on demand.

### 6. Router

Segment-based URL matching:

- Static segments: `/about` matches `/about`
- Dynamic segments: `/blog/:slug` matches `/blog/hello-world` with `params.slug = "hello-world"`
- Catch-all: `/docs/*` matches `/docs/a/b/c`

The router produces a flat list of resolved routes at build time. Runtime matching
is a simple linear scan (fast enough for typical route counts).

---

## Request Lifecycle

### SSR Request

```
Browser request
  → Adapter (Node/CF) converts to Web Request
  → Match route from manifest
  → Run middleware chain
  → Execute loader
  → Render Preact component tree to string
  → Merge head metadata (shell + route)
  → Inject escaped hydration state into a JSON script tag
  → Inject asset tags from Vite manifest
  → Return HTML Response
  → Browser hydrates, client router takes over
```

### SSG Build

```
Build starts
  → Resolve all routes with render: "ssg" or "isg"
  → For each: call prerender() if defined, else use static path
  → Execute loader for each path
  → Render to HTML string
  → Write to dist/client/<path>/index.html
  → Generate viact-route-manifest.json for runtime
```

### Client Navigation

```
User clicks <a> or calls navigate()
  → Client router matches new route
  → Fetch route state via GET with x-viact-route-state-request header
  → Server runs loader, returns JSON (no HTML rendering)
  → Client updates component tree with new data
  → Update URL via history.pushState
```

This "server-owned navigation" pattern means loaders never run in the browser.
Secrets in loader code stay server-side. The client only receives serialized data.

### Action Submission

```
User submits <Form> or calls submitAction()
  → POST to current route URL
  → Server validates same-origin (CSRF)
  → Run middleware
  → Execute action function
  → If revalidate hints: re-run affected loaders
  → Return JSON response
  → Client updates data and re-renders
```

---

## Build Pipeline

Viact uses Vite's multi-environment build:

### Environments

1. **client** — browser JavaScript + CSS
   - Entry: `virtual:viact/client`
   - Output: `dist/client/assets/` (hashed filenames)
   - Produces: `.vite/manifest.json` for asset injection

2. **ssr** — server bundle
   - Entry: `virtual:viact/server`
   - Output: `dist/ssr/` or `dist/server/`
   - Produces: route manifest JSON, ISG manifest JSON
   - Contains: loader/action/shell/middleware code

3. **platform** (adapter-specific) — entry module
   - Entry: `virtual:viact/node-server` or `virtual:viact/cloudflare-worker`
   - Wraps the SSR bundle with platform-specific request handling

### Build Outputs

```
dist/
  client/
    assets/                    # Hashed JS/CSS chunks
    .vite/manifest.json        # Client asset manifest
    index.html                 # SSG-generated pages...
    about/index.html
    blog/hello/index.html
  server/
    viact-route-manifest.json  # Route metadata for runtime
    viact-isg-manifest.json    # ISG revalidation config
    server.js                  # Platform entry module
```

---

## Adapter Pattern

Adapters are thin layers that translate between a platform's native request
handling and viact's Web Request/Response interface.

An adapter must:

1. **Convert** platform request → `Request`
2. **Serve** static assets from the client build
3. **Load** Vite manifests for asset tag injection
4. **Delegate** to the framework's `handleViactRequest()` for dynamic routes
5. **Implement** ISG revalidation using platform-appropriate storage
6. **Generate** a platform entry module via the Vite plugin

See [docs/ADAPTERS.md](ADAPTERS.md) for per-platform details.

---

## Custom Vite Plugins

Viact builds on Vite, and users can bring their own Vite plugins alongside the
viact plugin. Add them in `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { viact } from "@viact/vite-plugin";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [viact(), mdx(), tailwindcss()],
});
```

User plugins run alongside viact's plugin with no special integration needed.
They participate in the full Vite pipeline — transforms, virtual modules, dev
server middleware, build hooks — for both client and SSR builds.

### Common use cases

| Plugin                | Purpose                           |
| --------------------- | --------------------------------- |
| `@mdx-js/rollup`      | MDX content in route modules      |
| `@tailwindcss/vite`   | Tailwind CSS integration          |
| `vite-plugin-pwa`     | Service worker / PWA support      |
| `vite-imagetools`     | Image optimization and transforms |
| Custom Rollup plugins | Any Rollup-compatible transform   |

### Plugin ordering

Viact's plugin uses `enforce: "pre"` to resolve virtual modules before other
plugins. User plugins run at normal priority by default. If a plugin needs to
run before viact (e.g. to transform source before viact sees it), set
`enforce: "pre"` on that plugin as well — Vite respects declaration order within
the same enforcement level.

### SSR considerations

Plugins that only target the browser (e.g. injecting `<script>` tags) may need
conditional logic for SSR. Vite passes `{ ssr: true }` to plugin hooks during
the server build. See Vite's
[SSR plugin guide](https://vite.dev/guide/ssr#ssr-specific-plugin-logic) for
details.

---

## Type Safety

Viact provides end-to-end type inference from loader to component:

```typescript
export async function loader({ params }: LoaderArgs) {
  return { title: "Hello", count: 42 };
}

// LoaderData<typeof loader> = { title: string; count: number }
export function Component({ data }: RouteComponentProps<typeof loader>) {
  // data.title is string, data.count is number — no manual typing
}
```

The `LoaderData<T>` utility extracts the return type of a loader function,
unwrapping Promises. This flows through `useRouteData<typeof loader>()` on the
client side as well.

---

## Hydration

Server-rendered HTML includes a non-executable JSON script tag with serialized
state:

```html
<script id="viact-state" type="application/json">
  {"url":"/dashboard","routeId":"dashboard","data":{...}}
</script>
```

The client runtime reads this state to:

1. Hydrate the Preact component tree (matching server output)
2. Initialize the client router with current route data
3. Skip the initial loader fetch (data already present)

After hydration, the client router handles all subsequent navigation.
