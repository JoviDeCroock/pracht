---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-node": patch
"@pracht/cli": patch
"@pracht/core": patch
---

Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.
