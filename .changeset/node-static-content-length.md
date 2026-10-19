---
"@pracht/adapter-node": patch
---

Static files served by the Node server now send `Content-Length` on `GET` and `HEAD`.
