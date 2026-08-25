---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/core": patch
"@pracht/capabilities": patch
"create-pracht": patch
---

Add root request middleware to the pages router on serverful adapters.

A single root-level `_middleware.{ts,tsx,js,jsx}` in the pages directory is
registered as `"pages"` and applied to every page route. It is not applied to
API routes, does not become a route itself, and is included in generated and
ejected manifests so route inspection and devtools report the same graph.

Nested middleware files, `_middleware/` directories, unsupported extensions,
and duplicate root files are rejected instead of being silently ignored.
Empty `_middleware/` directories are rejected by build, doctor, and verify too,
and generation refuses every existing middleware-shaped path before scaffolding.
Build, doctor, and verify check the statically decidable contract: the module
must explicitly export `middleware`, or may provide it through a value
`export *`. Type-only local bindings re-exported under that name are rejected
because they are erased before runtime. The runtime remains authoritative for
whether the exported value is callable and fails closed when it is not.
Type-only TypeScript import-equals declarations are treated as erased exports.

Two pages-router conventions tighten as part of this. Underscore-prefixed
directories are now reserved for helpers, so `pages/_components/button.tsx` is
ignored instead of routed at `/_components/button`; move files that were meant
to be routes out of the underscore tree. `_app` is recognized only at the pages
root: a nested `_app` used to be promoted to the app shell, and is now rejected
by build, doctor, and verify rather than silently dropping the shell from every
route it looks like it wraps. An `_app` inside a reserved tree such as
`pages/_components/_app.tsx` stays a plain helper.

Prerendering now fails the build when an `ssg`/`isg` route renders a 5xx,
instead of warning and skipping it. A skipped route falls back to a live render
and returns the same error to every visitor, so one broken middleware module
used to turn every page into a 500 behind a green build. Deliberate 3xx/4xx
short-circuits still warn and skip.

`doctor` and `verify` warn when a manifest registers a middleware module inside
`routesDir` or `shellsDir` without the ejected-pages reservation, because the
client route and shell registries glob those directories and emit the
middleware source into the browser bundle. That is what happens to an ejected
pages layout whose `__PRACHT_EJECTED_PAGES_LAYOUT__` marker is dropped.

The pages client boundary excludes underscore-reserved helper trees and erases
the dedicated middleware module, keeping server-only middleware code out of
browser bundles. Ejected manifests carry an explicit ownership marker so this
boundary does not depend on interpreting registry source syntax.

`pracht generate middleware --name _middleware` and the matching MCP tool
scaffold the pages middleware file, reject duplicates, and refuse pure static
exports. Static-target detection now executes the Vite config and inspects the
adapter metadata on the selected Pracht plugin in the production build lane,
including the SSR-specific config branch and Vite's nested and thenable plugin
entries, so config functions, aliases, and future JavaScript syntax need no
separate source interpreter.
Generation fails closed when the executed config does not expose compatible
Pracht plugin metadata, preventing an independently upgraded CLI from
scaffolding middleware that an older Vite plugin would silently ignore.

Pages middleware edits participate in the existing HMR flow. The routing docs,
starter copy, examples, and bundled migration/scaffolding skills describe the
root-only, page-only, serverful-adapter contract. Path-based middleware examples
strip Vite's deploy base before comparing the public URL with route paths, so
migrated matchers keep working on sub-path deployments.
