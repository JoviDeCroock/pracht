---
"@pracht/core": patch
---

Custom servers that pass the `defineApp()` result to `handlePrachtRequest` no longer re-resolve the route manifest on every request.
