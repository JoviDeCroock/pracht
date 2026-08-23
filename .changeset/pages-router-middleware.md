---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
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
Build, doctor, and verify check the statically decidable contract: the module
must explicitly export `middleware`, or may provide it through a value
`export *`. The runtime remains authoritative for whether the exported value
is callable and fails closed when it is not.

The pages client boundary excludes underscore-reserved helper trees and erases
the dedicated middleware module, keeping server-only middleware code out of
browser bundles. Ejected manifests carry an explicit ownership marker so this
boundary does not depend on interpreting registry source syntax.

`pracht generate middleware --name _middleware` and the matching MCP tool
scaffold the pages middleware file, reject duplicates, and refuse pure static
exports. Static-target detection now executes the Vite config and inspects the
adapter metadata on the selected Pracht plugin in the production build lane,
including Vite's nested and thenable plugin entries, so config functions,
aliases, and future JavaScript syntax need no separate source interpreter.

Pages middleware edits participate in the existing HMR flow. The routing docs,
starter copy, examples, and bundled migration/scaffolding skills describe the
root-only, page-only, serverful-adapter contract.
