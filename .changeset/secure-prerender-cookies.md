---
"@pracht/core": patch
"@pracht/cli": patch
"@pracht/adapter-node": patch
"@pracht/vite-plugin": patch
---

Tighten prerender path safety by rejecting dynamic dot segments and unsafe static route segments, and by bounding SSG/ISG writes to `dist/client`. Deduplicate the default Node adapter entry generation and preserve multiple `Set-Cookie` headers in Node responses.
