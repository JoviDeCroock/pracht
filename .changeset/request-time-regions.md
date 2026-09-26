---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-cloudflare": minor
---

Components in `src/regions/` render per request with the visitor's cookies and the route's middleware context inside otherwise cached SSG/ISG pages, showing a `fallback` until they load, and render inline on SSR pages.
