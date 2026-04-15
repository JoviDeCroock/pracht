# Pracht Architecture

This document describes the core architecture, abstractions, and design decisions
behind pracht. It serves as the source of truth for contributors and AI agents
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
│  Node · CF · Vercel   │ │   dev · build · generate       │
└───────────────────────┘ └────────────────────────────────┘
```

---

## Core Abstractions

### 1. Route Manifest (`defineApp`, `route`, `group`)

The route manifest is the central configuration. Users define it in `src/routes.ts`:

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
      route("/about", () => import("./routes/about.tsx"), { render: "ssg" }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      // Inline style: loader exported from the route file
      route("/settings", () => import("./routes/settings.tsx"), { render: "spa" }),
      // Separate files style: server code in dedicated files
      route("/dashboard", {
        component: () => import("./routes/dashboard.tsx"),
        loader: () => import("./server/dashboard-loader.ts"),
        render: "ssr",
      }),
    ]),
  ],
});
```

**Why explicit over file-based?**

Pure file-based routing (Next.js, SvelteKit) couples URL structure to directory
structure. This forces awkward nesting for layout groups and makes middleware
assignment implicit via `_middleware.ts` files. Pracht's hybrid approach:

- Route modules live in `src/routes/` (discoverable by convention)
- Route _wiring_ is explicit in `src/routes.ts` (auditable, type-checked)
- Shells and middleware are named references (reusable across groups)
- URL structure is independent of file system layout

### 2. Route Modules

Pracht supports two styles for wiring data loading to routes. Both can coexist
in the same app.

#### Style A: Inline (loader in the route file)

A route module exports some combination of:

```typescript
// src/routes/dashboard.tsx

// Server: runs on request (SSR) or build (SSG)
export async function loader({ request, params, context, signal }: LoaderArgs) {
  return { user: await getUser(request) };
}

// Shared: <head> metadata
export function head({ data }: HeadArgs<typeof loader>) {
  return { title: `Dashboard — ${data.user.name}` };
}

// Server: document response headers
export function headers({ data }: HeadersArgs<typeof loader>) {
  return { "cache-control": data.isPublic ? "public, max-age=60" : "no-store" };
}

// Client + SSR: the page component
export default function Dashboard({ data }: RouteComponentProps<typeof loader>) {
  const liveData = useRouteData<typeof loader>();
  return <main>{liveData.user.name}</main>;
}

// Client + SSR: error boundary (optional)
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Something went wrong: {error.message}</p>;
}

// Build: enumerate params for SSG/ISG prerendering (optional)
export function getStaticPaths(): RouteParams[] {
  return [{ id: "1" }, { id: "2" }];
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
// src/routes/dashboard.tsx — pure component, no server code
export default function Dashboard({ data }: RouteComponentProps) {
  return <main>{data.user.name}</main>;
}
```

A named `Component` export is also supported for compatibility. Function-valued
default exports are treated as the page component; named exports such as
`loader`, `head`, `headers`, `ErrorBoundary`, and `getStaticPaths` keep their
framework roles.

Wired in the manifest via the `RouteConfig` object form:

```typescript
route("/dashboard", {
  component: () => import("./routes/dashboard.tsx"),
  loader: () => import("./server/dashboard-loader.ts"),
  render: "ssr",
});
```

When a separate file is specified, it takes precedence over inline exports in
the route module.

### 3. Shell Modules

Shells are Preact layout components that wrap route content:

```typescript
// src/shells/public.tsx
import type { ShellProps } from "@pracht/core";

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
    title: "Pracht App",
    meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
  };
}

export function headers() {
  return {
    "content-security-policy": "default-src 'self'",
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
import type { MiddlewareFn } from "@pracht/core";

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
  → Merge head metadata and document headers (shell + route)
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
  → Generate pracht-route-manifest.json for runtime
```

### Client Navigation

```
User clicks <a> or calls navigate()
  → Client router matches new route
  → In parallel:
      ├─ Fetch route state via GET with x-pracht-route-state-request header
      ├─ Import route module chunk
      └─ Import shell module chunk (if applicable)
  → Server runs loader, returns JSON (no HTML rendering)
  → Client updates component tree with new data + loaded modules
  → Update URL via history.pushState
```

Module imports are cached so repeated navigations to the same shell skip the import.
Prefetching (hover/intent/viewport) also warms module chunks alongside route-state data.

This "server-owned navigation" pattern means loaders never run in the browser.
Secrets in loader code stay server-side. The client only receives serialized data.

---

## Build Pipeline

Pracht uses Vite's multi-environment build:

### Environments

1. **client** — browser JavaScript + CSS
   - Entry: `virtual:pracht/client`
   - Output: `dist/client/assets/` (hashed filenames)
   - Produces: `.vite/manifest.json` for asset injection

2. **ssr** — server bundle
   - Entry: `virtual:pracht/server`
   - Output: `dist/ssr/` or `dist/server/`
   - Produces: route manifest JSON, ISG manifest JSON
   - Contains: loader/shell/middleware code

3. **platform** (adapter-specific) — entry module
   - Entry: `virtual:pracht/node-server` or `virtual:pracht/cloudflare-worker`
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
    pracht-route-manifest.json  # Route metadata for runtime
    pracht-isg-manifest.json    # ISG revalidation config
    server.js                  # Platform entry module
```

---

## Adapter Pattern

Adapters are thin layers that translate between a platform's native request
handling and pracht's Web Request/Response interface.

An adapter must:

1. **Convert** platform request → `Request`
2. **Serve** static assets from the client build
3. **Load** Vite manifests for asset tag injection
4. **Delegate** to the framework's `handlePrachtRequest()` for dynamic routes
5. **Implement** ISG revalidation using platform-appropriate storage
6. **Generate** a platform entry module via the Vite plugin

See [docs/ADAPTERS.md](ADAPTERS.md) for per-platform details.

---

## Custom Vite Plugins

Pracht builds on Vite, and users can bring their own Vite plugins alongside the
pracht plugin. Add them in `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [pracht(), mdx(), tailwindcss()],
});
```

User plugins run alongside pracht's plugin with no special integration needed.
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

Pracht's plugin uses `enforce: "pre"` to resolve virtual modules before other
plugins. User plugins run at normal priority by default. If a plugin needs to
run before pracht (e.g. to transform source before pracht sees it), set
`enforce: "pre"` on that plugin as well — Vite respects declaration order within
the same enforcement level.

### SSR considerations

Plugins that only target the browser (e.g. injecting `<script>` tags) may need
conditional logic for SSR. Vite passes `{ ssr: true }` to plugin hooks during
the server build. See Vite's
[SSR plugin guide](https://vite.dev/guide/ssr#ssr-specific-plugin-logic) for
details.

---

## Module Dependency Structure (`packages/framework/src`)

The internal module graph within the framework package is acyclic:

```
types.ts        — pure types, no internal deps
    ↑
app.ts          — route manifest, matching, SSG path building
    ↑
runtime.ts      — SSR handler, prerendering, client hooks (static import of app.ts)
    ↑
prefetch.ts     — prefetch cache, strategy wiring (imports runtime + app)
    ↑
router.ts       — client router, hydration bootstrap (imports runtime + prefetch + hydration)

hydration.ts    — Preact options hooks for tracking hydration (no internal deps)
forwardRef.ts   — forwardRef helper (no internal deps)
error-overlay.ts — dev error page HTML (no internal deps)
```

**Important:** `runtime.ts` imports `resolveApp` and `buildPathFromSegments` directly from
`app.ts` via a static import. Earlier versions used `await import("./app.ts")` dynamic
imports inside `prerenderApp` and `collectSSGPaths` — these were a defensive workaround
against a perceived circular dependency that never actually existed (since `app.ts` only
imports from `types.ts`). The dynamic imports have been replaced with static imports.

The only intentional dynamic import in `runtime.ts` is `preact-render-to-string`, which
is lazy-loaded to keep the SSR-only dependency out of the client bundle.

---

## Type Safety

Pracht provides end-to-end type inference from loader to component:

```typescript
export async function loader({ params }: LoaderArgs) {
  return { title: "Hello", count: 42 };
}

// LoaderData<typeof loader> = { title: string; count: number }
export default function Page({ data }: RouteComponentProps<typeof loader>) {
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
<script id="pracht-state" type="application/json">
  {"url":"/dashboard","routeId":"dashboard","data":{...}}
</script>
```

The client runtime reads this state to:

1. Hydrate the Preact component tree (matching server output)
2. Initialize the client router with current route data
3. Skip the initial loader fetch (data already present)

After hydration, the client router handles all subsequent navigation.

### Hydration & Suspense tracking

During SSR, Suspense boundaries render their resolved content (not the fallback).
When the client hydrates, lazy components throw promises but Suspense keeps the
server HTML alive in the DOM — no fallback is shown. The framework tracks these
in-flight suspensions so it knows when hydration is truly complete.

**How it works** (`packages/framework/src/hydration.ts`):

- `markHydrating()` is called by the router before `hydrate()` to set a global
  `_hydrating` flag.
- `options.__e` (\_catchError) intercepts thrown promises during hydration and,
  when the suspending vnode carries the `MODE_HYDRATE` flag, increments
  `_suspensionCount`; settling decrements it. The `MODE_HYDRATE` check is
  important: without it, an unrelated `render()` tree (portal, island, modal)
  that suspends while a hydrate is still in-flight would be mis-counted as a
  hydration suspension and pin `_hydrated` to `false`. This mirrors the same
  check preact-suspense uses internally to decide whether to preserve server
  DOM.
- `options.__c` (\_commit / commitRoot) runs once per commit root after the whole
  subtree has finished diffing. When `_hydrating` is true and `_suspensionCount`
  is zero, it flips `_hydrated = true`. Commit-root granularity (rather than
  per-vnode `diffed`) is important: otherwise the flag could flip between two
  sibling components in the same hydrate call, and the later sibling would
  observe `true` on its first render. It also handles Suspense resolution
  transparently — when a lazy boundary settles, its re-render runs a normal
  diff→commit cycle and `__c` catches it at the end.

**`useIsHydrated()` hook**:

```typescript
export function useIsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(_hydrated);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
```

`useState(_hydrated)` captures the correct initial value — if suspensions are
still pending `_hydrated` is `false`, so the component starts with `false`. The
`useEffect` fires after mount and flips to `true`. Components that mount after
hydration has already finished (e.g. via client navigation) start with
`useState(true)` immediately.

This means a lazy component inside a Suspense boundary that resolves during
hydration will see `false` on its first render (because `_hydrated` hasn't
been flipped yet) and `true` after its effect runs — the same false-to-true
transition as the rest of the tree.
