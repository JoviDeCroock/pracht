---
"@pracht/cli": minor
"@pracht/core": minor
---

Add zero-generic typed loader data keyed by route id.

`pracht typegen` now registers each route's loader data type on
`Register["routes"]` in the generated `src/pracht-routes.d.ts`, pointing at the
route module (or the separate loader module wired via the manifest, which wins
over an inline loader like at runtime). `@pracht/core` gains a
`RouteLoaderData<TModule, TFallbackModule?>` utility type, a
`RouteDataFor<TRouteId>` helper, and a new `useRouteData(routeId)` overload
that returns the mapped loader data with route-id autocomplete — no generic
needed. The existing `useRouteData<typeof loader>()` form keeps working as the
fallback for projects that do not run typegen. In development, passing a route
id that is not the active route logs a warning.
