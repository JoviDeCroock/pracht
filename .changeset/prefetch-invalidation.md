---
"@pracht/core": patch
---

Prefetched route data is now discarded after any mutation, including `apiFetch()` mutations, capability calls and `useRevalidate()`, so the next click no longer shows data from before the change.
