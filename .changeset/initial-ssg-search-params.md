---
"@pracht/core": patch
---

Expose reactive, read-only query parameters through `useSearchParams()`. SSG routes retain their prerendered URL for the hydration render, then publish the visitor's browser query after hydration while keeping prerendered route identity and data.
