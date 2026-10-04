---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": patch
"@pracht/adapter-cloudflare": patch
---

Server islands: components in `src/server-islands/` render per request, with the visitor's cookies and the middleware of the page that renders them, inside otherwise cached SSG/ISG pages, showing a `fallback` until they load. A route or shell lists the server islands it renders in `export const serverIslands`.
