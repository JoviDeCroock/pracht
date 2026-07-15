---
"@pracht/core": minor
"@pracht/cli": minor
---

Extend the app-graph serializers behind `pracht inspect --json`, the MCP
inspect tools, and the dev devtools endpoint. Serialized page routes now
include `hydration`, `prefetch`, and `speculation` (the resolved per-route
values, `null` when the route does not set them and the framework default
applies). Serialized API routes now include `hasDefaultHandler`, which is
`true` when the module exports a default catch-all request handler — detected
via module loading with a static `export default` source scan as fallback,
matching how HTTP methods are detected. `@pracht/core` also exports the new
`detectApiExports` helper (and `ApiRouteExports` type); `detectApiMethods`
keeps its existing signature. The human-readable `pracht inspect` output
prints the hydration mode per route and marks default-handler API routes
(`methods=GET+default` / `methods=default`).
