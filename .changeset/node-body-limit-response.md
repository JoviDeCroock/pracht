---
"@pracht/adapter-node": patch
---

Request bodies over `maxBodySize` on Node now get a `413` with the default security headers and `Connection: close` (up front when `Content-Length` already exceeds the limit), and accepted bodies are buffered with one copy fewer.
