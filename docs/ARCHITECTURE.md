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

        packages/capabilities
 contract · validation · trust · standalone HTTP/MCP host
```

`@pracht/capabilities` is below the framework boundary: `@pracht/core` uses
its server internals for integrated dispatch, while non-Pracht applications
use the curated `@pracht/capabilities/server` host and
`@pracht/capabilities/webmcp` registrar directly. Framework-only helpers are
published at `@pracht/capabilities/server/internal` so they do not become part
of the supported standalone API by accident.

---

## Shared tool and adapter contracts

Build and CLI verification consume the same source-analysis helpers from
`@pracht/capabilities/static`: environment access, Markdown fence masking,
pages configuration exports, render/hydration literals, revalidation literals,
and nearest-shell selection. File discovery and diagnostic presentation remain
with each consumer. The CLI uses core's route graph types and serialization,
so adding route metadata does not require a second projection implementation.

Node, Cloudflare, and Netlify use core's `applyHeadersManifest` and
`getManifestHeaders` helpers. Header lookup prefers an exact path, then the
trailing-slash-free path, then the path without `/index.html`. Adapter-specific
cache policy, storage, regeneration and request normalization remain local.

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

Server-side wrap-around functions that surround loaders and API handlers via
a `next()` callback:

```typescript
// src/middleware/auth.ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Middleware is named in the manifest and applied per route or group. It can
short-circuit with a Response, mutate `args.context`, or wrap the rest of
the request in `try / catch / finally` for logging and tracing. See
[ROUTING.md](./ROUTING.md#middleware) for the full contract.

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
  → If the route has a loader or middleware, in parallel:
      ├─ Fetch route state via GET with x-pracht-route-state-request header
      ├─ Import route module chunk
      └─ Import shell module chunk (if applicable)
  → Otherwise, import the route/shell modules only and skip the server fetch
  → Server runs middleware + loader when needed and returns JSON (no HTML rendering)
    with no-store by default or the route's private loaderCache duration
  → Client updates component tree with new data + loaded modules
  → Update URL via history.pushState
  → After the destination commits, replace WebMCP registrations with that route's capabilities
```

Module imports are cached so repeated navigations to the same shell skip the import.
Prefetching (hover/intent/viewport) also warms module chunks alongside route-state data.
Its bounded 30-second in-memory reuse window is independent of the route-state
response's browser HTTP cache policy.

This "server-owned navigation" pattern means loaders never run in the browser.
Secrets in loader code stay server-side. The client only receives serialized data.

---

## Dev Server Debugging

The Vite dev SSR middleware (`packages/vite-plugin/src/plugin-dev-ssr.ts`) adds two
dev-only debugging surfaces. Neither exists in production builds, and adapters that
own the dev server (`ownsDevServer: true`, e.g. Cloudflare's workerd-based dev) never
register this middleware — under those adapters `/_pracht` and `/_pracht.json` do not
exist at all (they 404), rather than existing and reporting nothing.

### `/_pracht` devtools page

- `GET /_pracht` serves a self-contained HTML page (no Preact and no JavaScript of
  its own — same approach as the error overlay in
  `packages/framework/src/error-overlay.ts`) listing every page route (pattern,
  render mode, shell, middleware chain, source file) and API route (path, methods,
  source file), with links to navigable routes. The page-route table includes
  each route's active WebMCP tools. Apps that register capabilities additionally
  get a Capabilities table with the inverse route mapping and an Agents traffic log.
- `GET /_pracht.json` serves the same data as JSON, plus the `agentTraffic` field
  described below.
- The static part of both is built from the shared app-graph helpers in
  `packages/framework/src/app-graph.ts` (`@pracht/core/devtools`) — the same
  serialization `pracht inspect --json` uses, so the CLI and the page never drift
  on the app graph itself.
- The path is reserved in dev only: a user route at `/_pracht` still wins in
  production, while in dev the middleware logs a collision warning and serves the
  devtools page.

### Agents traffic log

- The dev middleware passes `onCapabilityAudit` to `handlePrachtRequest()` and
  records each `CapabilityAuditEvent` into a bounded ring buffer
  (`packages/vite-plugin/src/agent-traffic.ts`, 200 events, newest first).
  Deliberately *not* a module-level audit hook: that slot belongs to the app, and
  a plugin-owned buffer cannot be reached from a production bundle or adapter.
- The buffer is merged into the response in `serveDevtools()`, not into
  `buildAppGraph()`. The graph is the static shape of the app and stays
  byte-identical to `pracht inspect --json`; traffic is live dev-server state, so
  `agentTraffic` exists only on the `/_pracht.json` response.
- `agentTraffic` is `{ limit, recorded, events[] }`. `recorded` is the total since
  the dev server started and survives eviction, so the page can report how many
  older events were dropped. Events carry `transport`, so JSON consumers do their
  own filtering. The HTML page counts verified identities, MCP, and MCP-caused
  composition as agent-attributed; shows top-level unsigned HTTP, HTTP-caused
  composition, and client-declared WebMCP markers separately as unverified
  client dispatches; and hides only `invokeCapability()` work with no
  served-request provenance behind a CSS-only first-party toggle.
- Not everything reaching the capability surface is audited: a cross-origin 403, an
  unknown-capability 404, and an unknown or unexposed MCP tool name all return
  before dispatch, so probes leave no trace. See `AGENT_TRUST.md`.

### `Server-Timing` header

In dev, every SSR page response carries a standards-compliant `Server-Timing` header,
e.g. `mw;dur=1.2, loader;dur=14.8, render;dur=3.1`, visible in the browser devtools
Network panel:

- `mw` — time spent in the middleware chain (excluding loader/render)
- `loader` — time awaiting the route loader (omitted when the route has none)
- `render` — module resolution + component rendering + HTML assembly

The runtime only records timings when the dev middleware passes a collector via
`HandlePrachtRequestOptions.timings`; production adapters never pass one, so
production requests skip all timing work.

### Writing the response

The dev middleware hands the runtime's `Response` to Node the same way the
production Node adapter does (`writeNodeResponseHeaders` in
`packages/adapter-node/src/node-request.ts`), and for the same reason: a
difference here only shows up after deploy.

- Headers are copied with `writeDevResponseHeaders()`, which reads `set-cookie`
  through `getSetCookie()`. `Headers.forEach()` yields that one header
  comma-joined and `res.setHeader()` replaces rather than appends, so a loader
  or API route setting two cookies would otherwise emit one broken header.
- Only a `text/html` body is decoded to text, because that is the one body this
  middleware rewrites (Vite's HTML transform). Every other body is piped as
  bytes, so a PDF, an image, or a `Uint8Array` from an API route is
  byte-identical in dev and production. `text/event-stream` keeps its own
  earlier branch: it must stream and never buffer.
- A page loader, page middleware, render, API handler, or API middleware failure is logged once to
  `server.config.logger`, with phase, route id, request path, and message —
  plus the matched route/loader/middleware source file, or `file:line:column`
  when the error blames a module of the user's
  (`describeAnnotatedUserModule()`), which is how a route file that will not
  compile gets named: it fails while the virtual server module is evaluated, so
  there is no route context to report. The overlay only reaches a document
  navigation; a route-state fetch, a `curl`, or a test run would otherwise see
  a 500 and nothing server-side. API failures use the dedicated `onApiError`
  hook and keep their JSON/plain-text response; only unclaimed page failures
  use `onRouteError` to opt into the browser overlay. A body stream that fails
  after the headers are on the wire is logged there too — destroying the socket
  is all that is left, so the line is the only signal. Expected 404s are not
  logged.
- The stack is appended only when the failure names no user module, or under
  `DEBUG` (`shouldIncludeDevErrorStack()`). A route/loader/shell file in
  `RouteErrorContext`, Vite's `id`/`loc.file` on a transform error, or a stack
  frame under the project root outside `node_modules` all count as named — the
  message and the overlay already locate those, and repeating the trace for
  each failing route-state poll buries the terminal. Anything unattributable is
  a framework or module-loading fault where the trace is the only clue.
- Both error paths check `res.headersSent` first. A failure *after* the
  response is on the wire would otherwise raise `ERR_HTTP_HEADERS_SENT` on top
  of the original error, replacing it as the thing the developer sees. When the
  response has *not* gone out, they clear the headers that described the body
  being abandoned — `content-length`, `content-type`, `content-encoding`,
  `transfer-encoding`, `content-disposition` — and only those. A stale
  `content-length` would truncate the error page written in its place, while
  clearing everything would also drop the CORS headers Vite's own middleware
  staged, answering a cross-origin 500 with a CORS failure and no readable
  overlay.

### Route hint tables

The generated client entry bakes in four per-route tables — does this module
export `loader`, `head`, `headers`, `getStaticPaths` — which the browser's
router reads to decide whether a navigation must fetch route state.
`createRouteHints()` (`route-loader-hints.ts`) builds all four from one
directory walk and one parse per route file; the per-table
`createRoute*Hints()` exports are thin wrappers over it, as is
`createRouteHintsForVirtualModules()` in `plugin-codegen.ts`, which resolves
the plugin's configured directories. Building them independently meant walking
`src/routes` and re-parsing every route module once per table, on every file of
every save.

`handleHotUpdate` compares the fresh scan against `emittedRouteHints` — a
snapshot of what `load()` last baked into the entry, not the table the previous
file in the same save just refreshed. A save that writes several files fires
`handleHotUpdate` once per file against a disk that already holds all of them,
so comparing against the freshly recomputed table reported "unchanged" for
every file after the first. A scan that had to skip an entry reports
`incomplete`, which forces reloads until `load()` rebuilds from a clean walk.

The separate CSS-injection middleware (used by adapter-owned dev servers)
buffers only responses whose content type is `text/html`, up to
`MAX_DEV_CSS_BUFFER_BYTES`; anything else keeps its `content-length`, its
backpressure signal, and its bytes.

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
   - Entry: `virtual:pracht/server`
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
    headers-manifest.json       # Prerendered document headers
    markdown-manifest.json      # Routes with raw Markdown representations
    isg-manifest.json           # ISG revalidation config
    server.js                  # Platform entry module
```

### Static assets (`public/`)

Vite copies `publicDir` into the client build's output, and `pracht build` then
moves that output into `dist/client/`. The CLI never re-copies `public/` itself,
so two things hold:

- A custom `publicDir` and `build.copyPublicDir: false` behave exactly as they
  do in a plain Vite build.
- A plugin that rewrites a copied asset in place (an image optimizer, say, in
  `closeBundle`) owns the file that ships — nothing restores the source over it.

The server build sets `copyPublicDir: false`: `dist/server/` is build tooling,
never an asset root, so duplicating `public/` there would only make every asset
plugin run a second, discarded pass.

### Optional server JSX precompile

`pracht({ precompileSsrJsx: true })` inserts `@pracht/preact-ssr-precompile`
before the normal Preact Vite preset for SSR transforms. The transform rewrites
safe native DOM JSX into `preact/jsx-runtime` `jsxTemplate()` calls, matching the
hidden runtime path used by Deno's JSX precompile transform. `preact-render-to-string`
then concatenates the static template strings and only renders dynamic VNodes,
avoiding many VNode/props allocations for SSR-heavy pages.

The option is server-only and opt-in: client builds keep normal JSX so hydration
still receives an ordinary VNode tree. The transform is conservative and falls
back for components, spreads, custom elements, `dangerouslySetInnerHTML`, and
HTML elements with special Preact SSR behavior.

---

## Adapter Pattern

Adapters are thin layers that translate between a platform's native request
handling and pracht's Web Request/Response interface.

An adapter must:

1. **Convert** platform request → `Request`
2. **Serve** static assets from the client build
3. **Load** Vite manifests for asset tag injection
4. **Delegate** to the framework's `handlePrachtRequest()` for dynamic routes
5. **Implement** ISG revalidation only when the platform has appropriate persistent storage/cache semantics; otherwise document the fallback clearly
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
name-suggestions.ts — edit-distance "did you mean" helpers for wiring errors
    ↑
app.ts          — route manifest, matching, SSG path building
    ↑
runtime-context.ts — hydration state reader and Preact runtime provider
    ↑
runtime-hooks.ts — public browser hooks/components (Link, Form, useRevalidate, etc.)
    ↑
runtime-request.ts — front half of the server pipeline: createRequestContext,
                     dispatchApi, dispatchAgentSurface (owns HandlePrachtRequestOptions)
    ↑
runtime-page.ts — back half: renderPage (middleware → loader → head/headers →
                  route-state JSON, SPA shell, or server-rendered document)
    ↑
runtime.ts      — handlePrachtRequest orchestrator + the public runtime re-exports
    ↑
prefetch-cache.ts — bounded route-state cache shared by navigation, forms, and prefetching
    ↑
prefetch-api.ts — imperative prefetch() surface + router registration (no listener code)
    ↑
prefetch.ts     — prefetch listener wiring (intent/viewport/render), loaded by the client router after hydration
    ↑
router.ts       — client router, hydration bootstrap (imports runtime-context + prefetch-api)

navigation-state.ts — shared useNavigation() store written by router.ts and <Form> (no internal deps)
navigation-blocker.ts — useBlocker() guard registry + the per-history-entry index that lets a
                        refused back/forward traversal be put back (imports navigation-state.ts)
scroll-restoration.ts — sessionStorage-backed per-history-entry scroll position store (no internal deps)
runtime-speculation.ts — builds the `<script type="speculationrules">` payload from
                         opted-in routes, including the link-level exclusion
                         selectors for anchors and image-map areas
                         (`rel="nofollow"`, `data-pracht-speculate="off"`);
                         consumed by runtime-html.ts (server) and router.ts /
                         prefetch.ts (browser, to skip prerender routes — and to
                         keep the SPA path for excluded anchors)

hydration.ts    — Preact options hooks for tracking hydration (no internal deps)
href.ts         — createHref helper layered on buildHref
forwardRef.ts   — forwardRef helper (no internal deps)
error-overlay.ts — dev error page HTML + stack-frame parsing (no internal deps)
dev-404.ts      — dev-only 404 page HTML listing registered routes (no internal deps)
```

The published core package also exposes small browser-oriented entries:

- `@pracht/core/client` is used by `virtual:pracht/client` and contains only
  the client router bootstrap surface.
- `@pracht/core/manifest` is used for manifest helper imports after Vite has
  transformed route module references to strings.
- `@pracht/core/server` is used by generated server entries and adapters so
  edge worker builds do not resolve server imports through the browser condition.
- `@pracht/core/error-overlay` and `@pracht/core/dev-404` are dev-only entries
  loaded on demand by the Vite dev middleware (via `ssrLoadModule`); no
  production entry point or generated server entry imports them.
- `@pracht/core/env` exposes `publicEnv` (client-safe, `PRACHT_PUBLIC_`-prefixed
  vars only); `@pracht/core/env/server` exposes `serverEnv` and is server-only —
  the vite plugin rejects client-side imports of it at build time, and its
  browser condition points at a throwing stub as a backstop for other bundlers.
- The root `@pracht/core` export has a browser condition that points at a
  client-safe public entry for route and shell modules. The condition carries
  its own `types`, so the ~70 server-only exports of `index.ts` are a compile
  error in client code instead of type-checking and then failing at bundle
  time. Anything genuinely pure that client code needs (`matchRoutePath`,
  `matchApiRoute`, `routePathIsDynamic`, `resolveApiRoutes`,
  `evaluateConstraints`) therefore has to be re-exported from `browser.ts` as
  well — a name missing there is unreachable from the browser, not merely
  untyped.

**Important:** the server pipeline modules import `resolveApp` and
`buildPathFromSegments` directly from `app.ts` via a static import. Earlier versions used
`await import("./app.ts")` dynamic imports inside `prerenderApp` and `collectSSGPaths` —
these were a defensive workaround against a perceived circular dependency that never
actually existed (since `app.ts` only imports from `types.ts`). The dynamic imports have
been replaced with static imports.

The dynamic imports that remain on the server are deliberate and load-bearing:
`preact-render-to-string` (kept out of the client bundle), and the agent-surface
runtimes — `runtime-capabilities.ts`, `runtime-mcp.ts`, `runtime-agent-context.ts`,
`runtime-agent-auth.ts` — which `runtime-request.ts` only reaches behind the
`__PRACHT_AGENT_SURFACE__` gate. That gate is repeated in `dispatchAgentSurface` even
though the runtime check there is redundant: the bundler can fold the define, but it
cannot prove a runtime read off the request context is always null, and without the
second gate a capability-free app ships the capability dispatch.
`packages/framework/test/package-tree-shaking.test.ts` holds that line.

The client router intentionally dynamic-imports `prefetch.ts` after router
initialization. Navigation keeps the small shared cache available synchronously,
but the listener and `IntersectionObserver` setup no longer sits on the critical
hydration path.

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
client side as well. Projects that run `pracht typegen` can drop the generic
entirely: the generated declaration registers each route's loader data on
`Register["routes"]`, so `useRouteData("dashboard")` resolves the data type
from the route id (see [docs/DATA_LOADING.md](DATA_LOADING.md#useroutedata)).

---

## Environment Variable Safety

Pracht separates env access into `serverEnv` (`@pracht/core/env/server`,
server-only, resolved per adapter) and `publicEnv` (`@pracht/core`, only
`PRACHT_PUBLIC_`-prefixed variables, inlined into client bundles via Vite's
`envPrefix`). Both are typed once through the `Register` declaration-merging
pattern (`Register["env"]`).

At build time the `pracht:env-safety` plugin scans client output chunks — and
the transformed sources of first-party modules included in them — for
references to non-public env vars and fails the build naming the variable,
chunk, and likely source module. `pracht({ envSafety: { allow: [...] } })` is
the escape hatch; successful client builds emit an env-safety report under
`dist/client/_pracht/`, and `pracht verify` uses that report plus a literal
chunk scan against `dist/client`.

See [docs/ENV.md](ENV.md) for the full model and per-adapter behavior.

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

During buffered SSR, Suspense boundaries render their resolved content (not the
fallback). A `streaming: true` SSR route instead commits the prepared shell with
unresolved fallbacks and resumes each boundary as its data settles.
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
  check Preact's compat Suspense uses internally to decide whether to preserve server
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

### Dev-only hydration warnings (`hydration-mismatch.ts`)

In development the client router calls `installHydrationMismatchWarning()`
which wraps three Preact options to surface common hydration bugs in a single
visible banner:

- `options.__m` (mismatch) — Preact already calls this when the
  server-rendered HTML and client vnode disagree. The wrapper appends a list
  item with the offending component name.
- `options.__e` (catchError) + `options.__c` (commit) — together they detect
  Suspense boundaries that resolve **during** hydration but render a number
  of top-level DOM nodes other than 1. Preact's compat hydration path
  assumes the resolved subtree replaces the server HTML in-place; if the
  resolved component returns 0 nodes (e.g. `null`) or >1 (a `Fragment` with
  multiple roots), sibling DOM offsets drift and subsequent updates can bind
  to the wrong nodes. The wrapper captures each suspending vnode (filtered
  by the `MODE_HYDRATE` flag, mirroring `hydration.ts`), waits for the
  post-resolve commit, walks `vnode.__c.__v.__k` to count DOM-bearing
  descendants, and warns when the count isn't exactly 1. Reads always go
  through the component instance's current vnode rather than the captured
  reference, so intermediate wrapper components between the Suspense
  boundary and the suspending vnode are handled correctly. The reported
  component name drills past Preact compat's `Lazy` wrapper (identified
  by its `displayName === "Lazy"`) so the warning names the resolved user
  component instead of the wrapper. See
  [preact issue #4442](https://github.com/preactjs/preact/issues/4442) for
  background.

The banner is only installed when `import.meta.env.DEV` is true, so the
overhead — and the wrappers themselves — never ship to production builds.

### Dev error overlay (`error-overlay.ts`)

When an uncaught error escapes the dev SSR middleware, the vite-plugin
renders a standalone HTML error page via `buildErrorOverlayHtml()` (exposed
as `@pracht/core/error-overlay`). The overlay is deliberately not a Preact
component — it must render even when Preact itself fails — and it is only
served by the dev middleware, never in production builds.

Failures *inside* `handlePrachtRequest()` never escape it: the runtime
answers them with a `text/plain` body, which is the right answer for a
production adapter and the wrong one for a browser. The dev middleware
therefore passes `onRouteError` and swaps that fallback for the overlay
(`shouldRenderDevErrorOverlay()`). The swap is deliberately narrow — a route
or shell `ErrorBoundary` is identified explicitly and left alone (even when
custom shell headers change its content type), and route-state failures are
JSON owned by the client router. `RouteErrorContext` carries that boundary
selection plus the phase and route/loader/shell module paths into the overlay,
since none is reliably recoverable from a stack trace. A loader module path
comes from the resolved route as a fallback, so a loader that fails during its
own import is still linked. Overlay responses retain the phase timings already
collected for the dev `Server-Timing` header. Every such failure is also logged
once to the dev terminal (see "Writing the response" above) — the overlay only
reaches a browser navigating to a document.

API handler and API middleware failures are already normalized inside the
runtime, so they cannot reach the dev middleware's outer catch either. The dev
middleware passes `onApiError` to log them with the same phase, route file, and
middleware-file context while leaving the API response body and content type
unchanged. This callback is separate from `onRouteError` so an API failure can
never satisfy the page-overlay handoff.

Four ergonomics features are built in:

- **Terminal colour codes are stripped.** oxc, esbuild, and Babel colourize
  their diagnostics for a TTY, and oxc wraps every character of the offending
  source line in its own SGR sequence. Rendered as-is in a browser, a syntax
  error becomes an unreadable wall of `[38;5;249m`. `stripAnsi()` runs over
  the message and the stack; the message keeps `white-space: pre-wrap` so the
  caret line still lines up.

- **Open-in-editor links.** `parseStackFrames()` parses V8-style stack
  traces into frames with `file:line:column` locations. App-code frames
  become clickable links that hit Vite's built-in
  `/__open-in-editor?file=<path>:<line>:<column>` endpoint (launch-editor
  middleware) via `fetch`. Frames from `node_modules`, `node:` internals,
  and Vite-internal/virtual modules are visually de-emphasized and never
  linked. Path normalization handles `file://` URLs, `/@fs/` prefixes,
  Vite transform queries (`?t=…`, `?pracht-client`), and root-relative
  dev-server URLs (`/src/routes/home.tsx`), which are joined onto the
  project root the dev middleware passes in (`server.config.root`).

- **Fixes reload the overlay.** The inline Vite HMR client reloads for both
  ordinary updates (`vite:beforeUpdate`) from client-reachable route modules
  and full reloads (`vite:beforeFullReload`) from server-only loaders or
  middleware. The listener is a module script because `import.meta.hot` is not
  valid in a classic script.

- **"Did you mean" wiring errors.** `resolveApp()` fails loudly when a
  route, group, or the `notFound` page references an unknown shell or
  middleware name (including `api.middleware`), and `buildHref()` does the
  same for unknown route ids.
  The messages include a closest-match suggestion (small internal
  edit-distance helper in `name-suggestions.ts`, no dependency) and the
  full list of registered names, e.g.
  `Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.`
  Because the virtual server module calls `resolveApp()` at load time,
  these errors surface in the overlay as soon as the dev server evaluates
  the manifest.
