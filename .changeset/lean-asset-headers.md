---
"@pracht/core": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
---

Immutable scripts, stylesheets, fonts, and source maps under `/assets/` are served with only `X-Content-Type-Options: nosniff` of the default security headers and without `ETag` or `Last-Modified`, since the others never apply to them.
