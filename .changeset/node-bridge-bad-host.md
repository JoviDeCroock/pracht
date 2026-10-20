---
"@pracht/adapter-node": patch
---

The Node server answers `400` instead of `500` for a `Host` with userinfo or URL delimiters (`user:pw@host`, `a/b`) and for a request target with credentials.
