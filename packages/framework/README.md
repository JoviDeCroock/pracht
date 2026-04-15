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

`handlePrachtRequest()` sanitizes unexpected 5xx errors by default so raw server
messages do not leak into SSR HTML or route-state JSON. Explicit
`PrachtHttpError` 4xx messages are preserved. Pass `debugErrors: true` to expose
raw details intentionally during debugging; `@pracht/core` does not infer this
from environment variables. Debug responses also attach `error.diagnostics`
metadata for the failure phase and matched framework files when available.

### Client

- `startApp()` — client-side hydration and runtime
- `useRouteData()` — access loader data inside a route component
- `useRevalidateRoute()` — trigger a revalidation of the current route's data
- `<Form>` — progressive enhancement form component

### Types

- `LoaderData<T>` — infer the return type of a loader
- `RouteComponentProps<T>` — props type for route components
- `LoaderArgs` — argument type passed to loaders

## Rendering Modes

Each route can specify its rendering mode:

- `ssr` — server-rendered on every request
- `ssg` — pre-rendered at build time
- `isg` — pre-rendered with time-based revalidation
- `spa` — client-only route rendering with optional shell/loading HTML on first paint
