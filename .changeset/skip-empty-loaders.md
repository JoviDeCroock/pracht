---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Skip route-state network requests for routes without loaders or middleware,
including manifest routes with inline loaders detected from route modules.
