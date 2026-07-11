---
"@pracht/adapter-cloudflare": patch
---

Retry generated Cloudflare headers and ISG manifest reads after transient asset fetch, response, or JSON failures instead of caching an empty manifest for the isolate lifetime. Missing manifests still cache as empty.
