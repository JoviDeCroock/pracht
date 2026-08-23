# @pracht/core

Core routing, rendering, server/client runtime, and type utilities for pracht.

## Install

```bash
npm install @pracht/core preact preact-render-to-string
```

## API

### Route Manifest

- `defineApp()` — define the application and its route tree
- `route()` — declare a route with path, component, loader, and rendering mode
- `group()` — group routes under a shared shell or middleware

Route modules may export the page as a function default export or as a named
`Component` export. Named exports such as `loader`, `head`, `ErrorBoundary`, and
`getStaticPaths` keep their special route-module behavior.

### Server

- `handlePrachtRequest()` — server renderer that produces full HTML with hydration markers
- `matchAppRoute()` — segment-based route matching
- `matchRoutePath()` / `routePathIsDynamic()` — shared single-pattern primitives for build tooling

`handlePrachtRequest()` sanitizes unexpected 5xx errors by default so raw server
messages do not leak into SSR HTML or route-state JSON. Explicit
`PrachtHttpError` 4xx messages are preserved. Pass `debugErrors: true` to expose
raw details intentionally during debugging; the flag is ignored when
`NODE_ENV=production`. Debug responses also attach `error.diagnostics`
metadata for the failure phase and matched framework files when available.

### Client

- `startApp()` — client-side hydration and runtime
- `useLocation()` — access the current pathname and search string separately
- `useSearchParams()` — read the current query as a reactive, read-only `URLSearchParams`
- `useRouteData()` — access loader data inside a route component; pass a route
  id for fully typed data after `pracht typegen`, or a `typeof loader` generic
  otherwise
- `useRevalidate()` — trigger a revalidation of the current route's data
- `<Form>` — progressive enhancement form component

### Types

- `LoaderData<T>` — infer the return type of a loader
- `RouteLoaderData<TModule, TFallbackModule?>` — infer loader data from a route
  module type; used by `pracht typegen` to key loader data by route id
- `RouteComponentProps<T>` — props type for route components
- `LoaderArgs` — argument type passed to loaders

### App graph serialization

The graph helpers exported from `@pracht/core` and `@pracht/core/server` support
custom inspection and development tooling:

- `serializeAppRoutes()` serializes resolved page routes.
- `serializeApiRoutes()` loads API modules and reports their callable exports.
  Pass `{ strict: true }` to fail with the route path and source file when a
  module cannot initialize instead of falling back to source inference.
- `serializeApiRoutesStatic()` and `detectApiExportsStatic()` inspect API
  exports without executing application modules. Supply
  `AppGraphStaticModuleAccess`, including `resolveModule` when star re-exports
  should be followed. Static default handlers are reported only when local
  syntax establishes a callable value.
- `serializeCapabilities()` loads registered capability contracts. Pass
  `{ strict: true }` to fail with the capability name and source file when a
  contract cannot initialize; the non-strict form retains diagnostic fallback
  metadata for development surfaces.
- `buildAppGraph()` combines resolved routes, API routes, capabilities, and the
  remote MCP endpoint into the shared `AppGraph` shape.

Use the static API helpers for startup banners and other read-only surfaces
where importing an application module would run unrelated top-level work. Use
strict module loading for authoritative inspection, planning, and verification;
silently inferred or null metadata is not authoritative enough for those
workflows.

## Rendering Modes

Each route can specify its rendering mode:

- `ssr` — server-rendered on every request
- `ssg` — pre-rendered at build time
- `isg` — pre-rendered with time-based revalidation
- `spa` — client-only route rendering with optional shell/loading HTML on first paint
