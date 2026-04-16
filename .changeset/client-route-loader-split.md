---
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Strip server-only route and shell exports from client module imports so inline loaders can statically import server-only dependencies without evaluating them in browser bundles.
