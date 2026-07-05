---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Add a dev-server startup banner and a rich dev-only 404 page.

`pracht dev` now prints a route table on startup — every page route with its
render mode, shell, and middleware, plus API routes with their HTTP methods —
alongside the local URL. The banner reuses the resolved-app-graph logic shared
with `pracht inspect` and respects `NO_COLOR`.

In dev mode, document navigations that match no page route and no API route now
render a styled standalone 404 page (new `@pracht/core/dev-404` entry, same
self-contained approach as the error overlay) listing all registered routes
with render modes and links plus the requested path. The module is only loaded
by the dev middleware; production 404 behavior is unchanged.
