---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"create-pracht": patch
---

Add `_middleware.ts` support to the pages router.

A root-level `_middleware.{ts,tsx,js,jsx}` in the pages directory exports the
same `MiddlewareFn` contract as manifest middleware. The generated manifest
registers it as a named middleware called `pages` and attaches it to every
page route, so `pracht inspect routes`, the dev banner, `/_pracht` devtools,
and the ejected manifest (`generateRoutesFile`) all reflect it. API routes are
not wrapped — the same independent-by-default behavior an explicit manifest
has — and the file never becomes a route.

Fail-open shapes are hard errors instead of silently ignored files: a nested
`_middleware` file, a `_middleware/` directory, a `_middleware.tsrx` file
(the middleware registry loads `.ts`/`.tsx`/`.js`/`.jsx` only), multiple
root-level files, and a module without a `middleware` export all fail the
build, `pracht doctor`, and `pracht verify` (the runtime already refused to
serve routes whose middleware lacks the export). The client bundle excludes
`_middleware` files from the pages route glob so server-only middleware code
is never emitted as a browser-loadable chunk.

`generateRoutesFile` now emits route and notFound references relative to the
ejected manifest's directory (`./pages/index.tsx` for `src/routes.ts` beside
`src/pages/`), matching how `_app`/`_middleware` were already referenced —
previously the ejected refs pointed at files that do not exist next to the
manifest and failed `pracht doctor`.

`pracht generate middleware --name _middleware` (and the `generate_middleware`
MCP tool) scaffolds the file in pages mode. HMR follows the existing pages
conventions: edits hot-invalidate, add/remove restarts the dev server.
