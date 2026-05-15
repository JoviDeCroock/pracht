---
"@pracht/core": patch
---

Fail closed when unresolved function-based `ModuleRef` values reach runtime.

`defineApp`/`route` now throw an explicit error for function module refs that were not rewritten by the Vite manifest transform, preventing empty-path fallback that could bypass middleware resolution.
