---
"@pracht/adapter-node": minor
---

`nodeAdapter({ earlyHints: true })` sends a `103 Early Hints` response with the page's stylesheets and scripts after route middleware passes and before loaders run, for deployments behind an HTTP/2 proxy that forwards it.
