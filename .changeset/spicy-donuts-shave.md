---
"@pracht/vite-plugin": patch
---

Fix dev-mode route handling so resolved app routes stay framework-owned even when the path includes dotted segments, asset-like filenames, or `@`-prefixed static handles. Route-state `_data=1` requests now also avoid the static-asset bypass.
