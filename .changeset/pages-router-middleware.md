---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/capabilities": patch
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
`_middleware` file, a `_middleware/` directory, middleware-shaped files using
unsupported page extensions such as Markdown/MDX, `.tsrx`, or a configured
custom format (the middleware registry loads `.ts`/`.tsx`/`.js`/`.jsx` only), multiple
root-level files, and a module without a runtime `middleware` export all fail
the build, `pracht doctor`, and `pracht verify` (the runtime already refused to
serve routes whose middleware lacks the export). The client bundle excludes
`_middleware` and its underscore-reserved helper files/directories from the
pages route and shell globs in both auto-discovered and ejected layouts, and the
client transform strips `middleware` exports as a second boundary, so
server-only middleware code and imports are never emitted as browser-loadable
chunks even when the root module re-exports an implementation from a reserved
helper. That transform is scoped to the dedicated root middleware module, so an
unrelated route or shell export named `middleware` keeps its normal
client-module semantics.

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

Build-time and CLI export validation also reject type-only star re-exports,
explicit or locally resolved type-only named aliases, ambient declarations,
and namespace re-exports such as `export * as middleware`: none exposes the
runtime `middleware` function required by the generated registration. CLI
verification accepts quoted runtime aliases such as
`export { fn as "middleware" }`, matching build-time module discovery, and
accepts `middleware` in a multi-declarator export. Both paths now use the same
AST classifier, and continue to reject nested `_middleware` files even when
another reserved underscore-prefixed directory contains them.

Ejected pages manifests are identified by either the marker emitted by
`generateRoutesFile` or the generated `pages` root-middleware registration
while it remains inside the configured pages route directory. That fallback
supports typed top-level variables, shorthand registry entries, and shorthand
registry objects without misclassifying an ordinary manifest that merely uses
a separately configured `_middleware.ts`. Retain the generated marker when
`_app` or `_middleware` moves to a conventional directory so the configured
pages route directory stays protected. Dedicated pages middleware modules also
strip value
`export *` declarations on the client boundary, so a star re-export cannot pull
its server-only implementation into a browser bundle through a direct import,
including when the middleware directory is separate from the route and shell
directories. Ordinary manifest apps may still co-locate route and shell modules
without having valid underscore-prefixed modules removed just because a
separate conventional middleware module is named `_middleware.ts`.

Changed-only verification now emits the pages-middleware success check only
after uniqueness and runtime-export validation succeeds, avoiding a
contradictory `ok` entry beside the blocking error.

The shared manifest registry extractor also preserves every JavaScript numeric
property-key form (including radix literals, separators, fractional literals,
and bigint keys), keeping numeric capability names visible to browser
projection, verification, and the server-only capability-module import
boundary. Identifier-backed registries and module refs are resolved from every
declarator in a top-level variable statement, so compact multi-declarator
manifests retain the same ejected-pages client isolation as dedicated bindings.
