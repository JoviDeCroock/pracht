---
"@pracht/adapter-cloudflare": patch
---

Regenerated ISG pages are cached per build, so a redeploy never serves a page the previous build rendered, even when both builds share a prerender timestamp.
