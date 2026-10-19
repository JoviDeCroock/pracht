---
"@pracht/content": patch
---

A content artifact without a `contentType` is served with the same type a static file of that extension gets, so `.csv`, `.webmanifest`, `.html` and other known extensions no longer fall back to `application/octet-stream`.
