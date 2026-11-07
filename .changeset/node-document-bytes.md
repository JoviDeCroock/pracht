---
"@pracht/core": patch
"@pracht/adapter-node": patch
---

The Node adapter writes server-rendered documents without streaming them back through a web stream, and sends them with `Content-Length` when uncompressed.
