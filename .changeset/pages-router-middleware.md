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
`_middleware` files from the pages route and shell globs in both auto-discovered
and ejected layouts, and the client transform strips `middleware` exports as a
second boundary, so server-only middleware code and imports are never emitted
as browser-loadable chunks. That transform is scoped to the dedicated root
middleware module, so an unrelated route or shell export named `middleware`
keeps its normal client-module semantics.

The pages scanner now applies the documented underscore reservation to whole
directory trees as well as files, so helpers such as
`pages/_components/button.tsx` stay out of the route graph instead of becoming
public `/_components/button` pages. The special `_middleware/` directory shape
continues to fail closed rather than being silently ignored.

`generateRoutesFile` now emits route and notFound references relative to the
ejected manifest's directory (`./pages/index.tsx` for `src/routes.ts` beside
`src/pages/`), matching how `_app`/`_middleware` were already referenced —
previously the ejected refs pointed at files that do not exist next to the
manifest and failed `pracht doctor`.

`pracht generate middleware --name _middleware` (and the `generate_middleware`
MCP tool) scaffolds the file in pages mode and refuses to create a duplicate
when another supported `_middleware` extension already exists. HMR follows the
existing pages conventions: edits hot-invalidate, add/remove restarts the dev
server. `doctor` and `verify` also reject `_middleware/` directories whose only
contents are non-source placeholders, matching the build-time check.

Build-time export validation also rejects type-only star re-exports and
namespace re-exports such as `export * as middleware`: neither exposes the
runtime `middleware` function required by the generated registration.
