---
"@pracht/core": minor
---

Add declarative app constraints: `defineApp({ constraints })` with `requireMiddleware`, `requireShell`, `requireRenderMode`, `forbidRenderMode`, and `requireHead` helpers, a segment-wise route pattern matcher (`*` = one segment, trailing `**` = zero or more), and a pure `evaluateConstraints` evaluator. Constraints are carried through `resolveApp()` and enforced by `pracht verify`. The serialized app graph (`serializeAppRoutes`, devtools JSON, `pracht inspect`) now also includes each route's `hydration` mode.
