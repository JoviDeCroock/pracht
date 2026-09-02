---
"@pracht/vite-plugin": patch
---

Limit the dev stylesheet-injection middleware to HTML responses, so other responses keep their `content-length`, their backpressure signal, and their bytes.
