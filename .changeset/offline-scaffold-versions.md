---
"create-pracht": patch
---

When the npm registry cannot be reached, `create-pracht` now scaffolds the `@pracht/*` versions it was released with and lists them in a warning, instead of silently pinning ranges several releases old, and new apps require a `preact-render-to-string` that satisfies `@pracht/core`'s peer range.
