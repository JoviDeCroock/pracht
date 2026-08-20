---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Stop static exports from requesting route-state files that can never exist.

A route with dynamic segments is prerendered only for the paths `getStaticPaths()` enumerates. A module that exports none is prerendered for no path, so no route-state file exists for any URL matching it — yet the client still requested one on every navigation, because head metadata inherited from the shell forces the fetch. On a host without a `200.html` rewrite that meant a guaranteed 404 (two, counting link prefetch) and console errors on every navigation to a dynamic `render: "spa"` route, the shape that route mode is for.

The vite plugin now records `getStaticPaths()` presence per route file alongside the existing loader and head hints, and the client skips the request when a static build proves the route has no enumerated paths. The rendered result is unchanged — client render with no loader data and empty font-head fragments, the same state the missing-state path produced — minus the request. Narrowing only ever happens on a proven `false`: formats compiled by a companion Vite plugin and route modules outside the scanned routes directory keep fetching, as do routes whose `getStaticPaths()` did enumerate the visited path.
