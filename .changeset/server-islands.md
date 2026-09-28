---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-cloudflare": minor
---

Server islands: components in `src/server-islands/` render per request, with the visitor's cookies and the middleware of the page that renders them, inside otherwise cached SSG/ISG pages, showing a `fallback` until they load.
