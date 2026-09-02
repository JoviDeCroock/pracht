---
"@pracht/core": patch
---

The `browser` export condition now resolves its own type declarations, so server-only exports such as `handlePrachtRequest` are a compile error in client code rather than a bundling failure. `matchRoutePath`, `matchApiRoute`, `routePathIsDynamic`, `resolveApiRoutes`, and `evaluateConstraints` are now reachable from the browser entry.
