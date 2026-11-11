---
"@pracht/core": patch
---

The first page load starts the shell chunk alongside the route chunk, and an SPA route's chunk alongside its route-state request, instead of one after the other.
