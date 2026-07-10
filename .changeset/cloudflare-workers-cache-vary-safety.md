---
"@pracht/adapter-cloudflare": patch
---

Prevent Cloudflare Workers Caching from stamping public edge-cache headers on ISG responses that vary by cookie, authorization, or all request headers.
