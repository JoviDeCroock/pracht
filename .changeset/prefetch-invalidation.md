---
"@pracht/core": patch
---

Prefetched route data is now discarded after any mutation, including `apiFetch()` mutations, capability calls and `useRevalidate()`, so neither the next click nor a navigation already loading shows data from before the change.
