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
```

Module imports are cached so repeated navigations to the same shell skip the import.
Prefetching (hover/intent/viewport) also warms module chunks alongside route-state data.
Its bounded 30-second in-memory reuse window is independent of the route-state
response's browser HTTP cache policy.

This "server-owned navigation" pattern means loaders never run in the browser.
Secrets in loader code stay server-side. The client only receives serialized data.

---

## Dev Server Debugging

Development serving is split by responsibility: `plugin-dev-ssr.ts` owns framework
request orchestration, `plugin-dev-routing.ts` owns pure route/request
classification, `plugin-dev-request.ts` converts bounded Node requests to the Web
Request contract, `plugin-dev-responses.ts` renders error overlays and rich
not-found responses, `plugin-devtools.ts` builds the live app-graph inspection
endpoints, and `plugin-dev-css.ts` owns Vite module-graph stylesheet discovery,
document injection, and the response adapter used by adapter-owned dev servers. The
SSR middleware adds two dev-only debugging surfaces. Neither exists in production
builds, and adapters that own the dev server (`ownsDevServer: true`, e.g.
Cloudflare's workerd-based dev) bypass this middleware and therefore don't expose
them.

Build-time deployment checks are also isolated from the main plugin composition:
`plugin-edge-runtime-safety.ts` owns the post-bundle scan that rejects surviving
Node.js builtin imports for edge adapters. This keeps platform compatibility
validation independent from virtual-module generation and development serving.
`plugin-optimize-deps.ts` owns Preact deduplication and the Vite scan entries for
generated route files and virtual client dependencies, including the workspace-link
guard that prevents splitting the core runtime into two copies.
`plugin-client-safety.ts` owns client-side server-export stripping and registered
capability import rejection; `plugin-paths.ts` centralizes canonical Vite file
identity so symlinked projects cannot bypass either client or manifest guards.
The client-module transform behind that safety hook is phase-oriented:
`client-module-server-exports.ts` selects the server contract to remove,
`client-module-binding-pruning.ts` settles dependency liveness, and the focused
state, scope-analysis, and render modules preserve source identity around them.
`plugin-manifest-transform.ts` owns the authoring-to-runtime manifest rewrite,
while the primary `pracht` plugin retains the stable transform hook used by Vite
and direct plugin tooling.
`plugin-hot-update.ts` owns page-directory watching, virtual-module invalidation,
and the server-only full-reload decision used by the primary lifecycle hook.

### `/_pracht` devtools page

- `GET /_pracht` serves a self-contained HTML page (no Preact — same approach as the
  error overlay in `packages/framework/src/error-overlay.ts`) listing every page route
  (pattern, render mode, shell, middleware chain, source file) and API route
  (path, methods, source file), with links to navigable routes.
- `GET /_pracht.json` serves the same data as JSON.
- Both are built from the shared app-graph helpers in
  `packages/framework/src/app-graph.ts` (`@pracht/core/devtools`) — the same
  serialization `pracht inspect --json` uses, so the CLI and the page never drift.
- The path is reserved in dev only: a user route at `/_pracht` still wins in
  production, while in dev the middleware logs a collision warning and serves the
  devtools page.

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

Vercel output generation keeps `vercel-build-output.ts` as the orchestration
boundary. `vercel-output-config.ts` owns the pure Build Output API routing and
function documents, while `vercel-prerender-output.ts` owns ISR function
materialization, fallback movement, and shared-function linking.

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

The package keeps AST lowering in `transform.ts` and the pure output rules in
`html-serialization.ts`. Attribute-name normalization, entity encoding, JSX
text whitespace, boolean attributes, and safe native-element classification
therefore share one testable policy boundary instead of being embedded in the
tree traversal.

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

Adapter package entrypoints should stay as public facades. Platform-plugin
composition, generated entry source, graph-inspection substitutes, request
runtime, and cache/storage policy belong to focused modules so contributors can
change one platform boundary without loading the others into the same file.

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
registration.ts — declaration-merging registry and framework request-context extensions
capability-types.ts — generated capability registration and browser-client inference
agent-types.ts — Web Bot Auth, approval-store, MCP projection, and audit contracts
route-inputs.ts — route-param and search-param wire inputs shared by links and API calls
route-client-types.ts — generated route IDs, params, search, data, and href inference
api-client-types.ts — generated API registration, request options, and response inference
navigation-types.ts — navigation options, prefetch policy, and speculation contracts
route-policy-types.ts — rendering, hydration, revalidation, and route metadata contracts
app-types.ts — authored and resolved application, route, API, and segment models
runtime-module-types.ts — loader, middleware, route/shell module, and registry contracts
http-errors.ts — concrete PrachtHttpError and notFound() behavior
types.ts        — stable aggregate over the focused public type domains
    ↑
name-suggestions.ts — edit-distance "did you mean" helpers for wiring errors
    ↑
app-definition.ts — route/group/app authoring DSL and module-reference normalization
app.ts          — resolved route graph, matching, and inherited route flattening
app-validation.ts — manifest keys, registered names, cache values, and render compatibility
api-validation.ts — stable typed API validation facade
api-validation-types.ts — JSON compatibility and defineApi inference contracts
api-json-response.ts — payload-preserving JSON response construction
api-validated-handler.ts — defineApi request validation and handler execution
api-request-validation.ts — request parsing, normalized issues, and Standard Schema execution
    ↑
runtime-context.ts — hydration state reader and Preact runtime provider
    ↑
runtime-redirect.ts — safe redirect target validation and method-aware status policy
runtime-middleware-chain.ts — concurrent module loading and sequential fail-closed execution
runtime-document-metadata.ts — shell/route head and document-header aggregation
runtime-middleware.ts — stable middleware helper facade
runtime-header-values.ts — portable value validation, application, and Vary composition
runtime-response-security.ts — browser security defaults and protocol-switch preservation
runtime-response-cache.ts — cross-adapter heuristic caching prevention
runtime-route-response-headers.ts — route-state cache and response-header policy
runtime-capability-form-redirect.ts — enhanced-form redirect transport handshake
runtime-headers.ts — stable response-header helper facade
runtime-form.ts — stable Form props/render facade and event-flow orchestration
runtime-form-native.ts — submitter resolution and validated native resubmission guard
runtime-api-form.ts — ordinary API validation, fetch, redirect, and response handling
runtime-capability-form.ts — capability endpoint safety, envelopes, and settlement events
runtime-hooks.ts — public browser hook/Link facade and stable Form re-export
islands-server.ts — island registry, vnode interception, and SSR marker boundaries
islands-serialization.ts — hydration-strategy and JSON prop wire validation
    ↑
runtime-request-setup.ts — route-state request normalization and resolved-app preparation
runtime-page-dispatch.ts — terminal page matching, method gating, and not-found settlement
runtime.ts      — stable API → agent → page request lifecycle coordinator
runtime-rendering.ts — lazy shared Preact server-renderer loading
runtime-route-state-response.ts — JSON errors, redirects, and route-state cache headers
runtime-response-types.ts — shared generated-asset options for runtime error views
runtime-api-error-response.ts — API diagnostics, sanitization, and plaintext fallback
runtime-route-error-response.ts — route ErrorBoundary rendering and hydration assets
runtime-response.ts — stable response-helper facade
revalidation-request.ts — webhook authentication, bounded path parsing, and safe regeneration requests
revalidation.ts — cache policy, single-flight control, outcome reporting, and stable request facade
runtime-capability-registry.ts — capability manifest loading, contract validation,
                                 cache identity, and HTTP path matching
runtime-capability-pipeline.ts — shared input validation, named middleware, execution,
                                 output validation, and response normalization
runtime-capability-audit.ts — observer registration, trusted identity snapshots,
                              and fail-safe audit delivery
runtime-capability-invocation-types.ts — host and direct invocation contracts
runtime-capability-host.ts — request-scoped host binding and identity snapshots
runtime-capability-composition.ts — nested transport policy and trusted context binding
runtime-capability-invocation-dispatch.ts — explicit-host pipeline and audit execution
runtime-capability-invocation.ts — stable direct-invocation overload facade
runtime-confirmation-token.ts — canonical input binding, HMAC token codec, and verification
runtime-confirmation-replay.ts — bounded per-instance single-use token tracking
runtime-confirmation.ts — secret configuration and stable confirmation facade
runtime-capability-approval-transitions.ts — fail-closed durable prepare/consume transitions
runtime-capability-confirmation.ts — principal binding, token gate, and flow orchestration
runtime-capability-transport-types.ts — type-only HTTP/MCP dispatch contracts
runtime-capability-http-dispatch.ts — body parsing, agent policy, confirmation, and pipeline dispatch
runtime-capability-api-middleware.ts — app API middleware wrapping and short-circuit normalization
runtime-capability-mcp-output.ts — MCP middleware success-envelope schema settlement
runtime-capabilities.ts — public transport facade, effect header, and audit orchestration
runtime-request-provenance.ts — browser provenance and exact-origin request policy
runtime-api.ts — explicit API matching, middleware, invocation, and error normalization
api-routes.ts — file-path discovery, route specificity ordering, and API path matching
api-export-detection.ts — runtime/source fallback, re-export traversal, and HTTP method reporting
api-export-source-scan.ts — stable internal source-analysis facade
api-export-source-lexical.ts — offset-preserving masking and module-scope tracking
api-export-callable-source.ts — conservative callable-default inference
llms-txt.ts — deterministic section rendering and stable public builder
llms-txt-types.ts — public builder configuration contracts
llms-txt-entries.ts — page, API, and capability entry collection
llms-txt-exclusions.ts — reserved-path and configured publication policy
app-agent-validation.ts — fail-closed agent policy and trust-setting validation
runtime-agent-surface.ts — lazy agent runtimes, signature binding, and invocation host setup
runtime-agent-projection.ts — MCP and capability HTTP selection and fail-closed routing
runtime-agent-auth.ts — Web Bot Auth freshness, directory allowlisting, and verification policy
runtime-agent-directory.ts — bounded key discovery, caching, and strict Ed25519 JWKS validation
runtime-agent-signature.ts — structured signature parsing and RFC 9421 base construction
agent-auth-sign.ts — stable outbound signing entry facade
agent-auth-sign-types.ts — outbound signing options, headers, and JWK contracts
agent-auth-request-signing.ts — RFC 9421 signing base and request/header construction
agent-auth-key-pair.ts — Ed25519 key generation and thumbprint lifecycle
runtime-context-overlay.ts — immutable context proxy invariants, receiver binding, and native-slot guards
runtime-mcp-protocol.ts — JSON-RPC framing, initialization validation, and version negotiation
runtime-mcp-request.ts — stateless HTTP hardening and JSON-RPC request preparation
runtime-mcp-tool-registry.ts — exposed tool namespace validation and collision policy
runtime-mcp-tools.ts — tools/list descriptors and capability-envelope result projection
runtime-mcp-dispatch.ts — tool lookup, credential-safe request synthesis, host rebinding, and execution
runtime-mcp.ts — stable remote MCP facade and method routing
runtime-page-render.ts — Markdown, SPA, hydrated, islands, and zero-JavaScript representations
runtime-page-pipeline.ts — concurrent module loading, middleware, loaders, timings, and fallback
    ↑
prefetch-cache.ts — bounded route-state cache shared by navigation, forms, and prefetching
    ↑
prefetch-api.ts — imperative prefetch() surface + router registration (no listener code)
    ↑
prefetch.ts     — prefetch listener wiring (intent/viewport/render), loaded by the client router after hydration
    ↑
router.ts       — client-router composition, lifecycle wiring, and public facade
router-bootstrap.ts — initial SSR hydration and pending SPA route-state completion
router-browser.ts — same-origin URL resolution, hashchange dispatch, and View Transition commits
router-history.ts — history entry keys, fragment commits, popstate, and scroll restoration
router-links.ts — anchor eligibility, fragment interception, and speculation-aware navigation
router-navigation.ts — public navigation context, hook, and typed navigation contract
router-navigator.ts — cancellable route-state fetch, redirect, history, and render transaction
router-renderer.ts — module loading, route-state resolution, Preact commits, and hydration

navigation-state.ts — shared useNavigation() store written by router.ts and <Form> (no internal deps)
scroll-restoration.ts — sessionStorage-backed per-history-entry scroll position store (no internal deps)
runtime-speculation.ts — builds the `<script type="speculationrules">` payload from
                         opted-in routes; consumed by runtime-html.ts (server) and
                         router.ts / prefetch.ts (browser, to skip prerender routes)

hydration.ts    — Preact options hooks for tracking hydration (no internal deps)
href.ts         — createHref helper layered on buildHref
forwardRef.ts   — forwardRef helper (no internal deps)
error-overlay.ts — stable dev error-overlay package facade
error-overlay/   — stack parsing, editor path normalization, and standalone HTML rendering
dev-404.ts      — dev-only 404 page HTML listing registered routes (no internal deps)
```

The Vite plugin keeps virtual-module assembly separate from source discovery:

- `plugin-codegen.ts` is the stable generator facade.
- `plugin-client-codegen.ts` owns client hydration and islands bootstrap source.
- `plugin-server-codegen.ts` owns build-aware server and adapter entry assembly.
- `plugin-dev-codegen.ts` owns the adapter-neutral development inspection graph.
- `plugin-codegen-route-hints.ts` owns the generated loader-hint helper shared
  by client and server entries.
- `plugin-registry-codegen.ts` owns the lazy route, shell, middleware, API,
  data, and capability registry source shared by server and development.
- `plugin-llms-txt-config.ts` owns package-metadata fallback and normalization
  for the generated server module's `llms.txt` configuration.
- `plugin-route-sources.ts` scans manifest/pages sources for hydration
  exclusions and loader hints, and owns the cached inline pages manifest.

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
  client-safe public entry for route and shell modules.

The type graph follows the same ownership rule as the runtime graph: domain
modules depend on narrower leaves, while `types.ts` only aggregates their public
contracts. Concrete behavior such as `notFound()` does not live in that type
aggregate.

`runtime-request-setup.ts` statically imports app resolution from `app.ts`; the
type graph remains acyclic because `app.ts` depends on narrower contracts.
Server rendering loads `preact-render-to-string` lazily through
`runtime-rendering.ts`, keeping the SSR-only dependency out of client bundles.

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

### Dev-only hydration warnings (`hydration-mismatch.ts`)

In development the client router calls `installHydrationMismatchWarning()`
which wraps three Preact options to surface common hydration bugs in a single
visible banner:

- `options.__m` (mismatch) — Preact already calls this when the
  server-rendered HTML and client vnode disagree. The wrapper appends a list
  item with the offending component name.
- `options.__e` (catchError) + `options.__c` (commit) — together they detect
  Suspense boundaries that resolve **during** hydration but render a number
  of top-level DOM nodes other than 1. Preact-suspense's hydration path
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
  component name drills past preact-suspense's `Lazy` wrapper (identified
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

The published entry is a small facade: `error-overlay/stack.ts` owns V8 stack
classification, `editor-path.ts` owns filesystem paths for Vite's editor
endpoint, and `render.ts` owns the dependency-free HTML document.

Two ergonomics features are built in:

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
