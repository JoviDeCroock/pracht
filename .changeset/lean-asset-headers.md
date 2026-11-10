---
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
---

Hashed scripts, stylesheets, fonts, and source maps under `/assets/` are served with smaller response headers, dropping the document-only security headers and the unused `ETag` and `Last-Modified` validators.
