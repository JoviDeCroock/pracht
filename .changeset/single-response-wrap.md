---
"@pracht/core": patch
---

Server-rendered documents and route-state responses no longer copy their headers and body into a second `Response` on the way out.
