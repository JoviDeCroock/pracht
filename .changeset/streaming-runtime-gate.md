---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Apps with no streaming route no longer ship the code that revives streamed `defer()` values in the browser entry.
