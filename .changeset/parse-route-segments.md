---
"@pracht/core": minor
"@pracht/cli": patch
---

`parseRouteSegments()` is exported from `@pracht/core`, and `pracht generate route` with a named catch-all such as `/docs/:path*` writes a `getStaticPaths()` stub keyed by `path`.
