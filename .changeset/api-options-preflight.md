---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

An API route that exports an `OPTIONS` handler now answers cross-origin preflights itself, in `pracht dev` as in production, instead of getting a `403` (production) or Vite's generic `204` (dev).
