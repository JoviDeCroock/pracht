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
custom format, plus any other exact `_middleware` basename the registry cannot
load (including extensionless files and alternate Node extensions), multiple
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
manifest and failed `pracht doctor`. Re-ejecting to a file inside the pages
directory also excludes the previous generated output from the route scan.

`pracht generate middleware --name _middleware` (and the `generate_middleware`
MCP tool) scaffolds the file in pages mode and refuses to create a duplicate
when another supported `_middleware` extension already exists. HMR follows the
existing pages conventions: edits hot-invalidate, add/remove restarts the dev
server. `doctor` and `verify` also reject `_middleware/` directories whose only
contents are non-source placeholders, matching the build-time check.
Static-adapter detection follows the exported Vite configuration, so an unused
helper that constructs a static Pracht configuration does not block middleware
generation when the selected adapter is serverful. Generated pages-starter
agent instructions now list the root middleware scaffolding command too.

Build-time and CLI export validation also reject type-only star re-exports,
explicit or locally resolved type-only named aliases, ambient declarations,
unresolved local aliases, and namespace re-exports such as
`export * as middleware`: none exposes the runtime `middleware` function
required by the generated registration. CLI
verification accepts quoted runtime aliases such as
`export { fn as "middleware" }`, matching build-time module discovery, and
accepts callable `middleware` bindings in a multi-declarator export. Statically
non-callable bindings such as `export const middleware = 1`, uninitialized
declarations, object literals, and local aliases of those values are rejected
before deployment instead of taking down every wrapped route at request time;
this includes direct and transitive aliases in exported declarations. Mutable
bindings use their last unconditional module-scope write, so assigning a
literal or applying an update after a callable initializer is rejected too,
including writes inside top-level sequence and chained assignment expressions.
Definitely evaluated writes nested in unary, binary, call, array, object,
template, and other ordinary expression wrappers are classified the same way,
while short-circuit, conditional, and optional-chain branches remain
conservative.

Nested assignments are recorded in runtime evaluation order, so the outer assignment's
final callable value is not overwritten by an earlier right-hand-side write in
the static result.
Both paths use the same AST classifier, and continue to reject nested
`_middleware` files even when another reserved underscore-prefixed directory
contains them.

Ejected pages manifests export a durable
`__PRACHT_EJECTED_PAGES_LAYOUT__ = true` marker. Client isolation keys only off
that explicit ownership signal rather than inferring pages semantics from a
middleware registry name or file path. Computed keys, spreads, and helper
variables therefore cannot make an ejected layout leak server-only helpers,
while ordinary co-located manifest apps may freely use a `pages` middleware or
underscore-prefixed route modules without being misclassified. Retain the
exported marker when `_app` or `_middleware` moves to a conventional directory.
Dedicated pages middleware modules also strip value
`export *` declarations on the client boundary, so a star re-export cannot pull
its server-only implementation into a browser bundle through a direct import,
including when the middleware directory is separate from the route and shell
directories. The dedicated module is now erased completely in client builds,
so top-level effects, side-effect-only imports, and unrelated exports cannot
survive a direct browser import either. Ordinary manifest apps may still
co-locate route and shell modules without having valid underscore-prefixed
modules removed just because a separate conventional middleware module is
named `_middleware.ts`.

Build and CLI validation also reject namespace imports re-exported as
`middleware` and literal object/array destructuring whose `middleware` binding
is provably non-callable. Callable literal destructuring and dynamic bindings
remain supported.

Changed-only verification now emits the pages-middleware success check only
after uniqueness and runtime-export validation succeeds, avoiding a
contradictory `ok` entry beside the blocking error.

The shared manifest registry extractor also preserves every JavaScript numeric
property-key form (including radix literals, separators, fractional literals,
and bigint keys), keeping numeric capability names visible to browser
projection, verification, and the server-only capability-module import
boundary. Identifier-backed registries and module refs are resolved from every
declarator in a top-level variable statement, so compact multi-declarator
capability registries retain the same projection and server-only boundaries as
dedicated bindings.

The bundled auth-audit and Next.js-migration skills now treat pages-router
`ssg`/`isg` documents as public unless an independent per-request edge gate is
verified; build-time middleware and live route-state gating are not presented
as protection for already-emitted static HTML.

Ejected-pages ownership detection now parses the exported marker rather than
matching one exact source spelling, so TypeScript annotations and `as const`
wrappers cannot accidentally disable the client-side middleware boundary.
Manifest registry extraction follows transitive local aliases with cycle
protection, keeping composed string module refs visible to capability browser
projection, CLI verification, and the registered-module client import guard.

Middleware export validation also rejects binary and update expressions whose
runtime result is necessarily non-callable, while preserving callable
TypeScript function/namespace declaration merges exported under an alias.

TypeScript angle-bracket assertions are treated as transparent during both
middleware callable validation and ejected-pages ownership detection, so they
cannot hide a non-callable middleware value or disable the client boundary.

Identifier-backed manifest registries and module refs now also preserve their
static registration through transparent parentheses and TypeScript `as` or
`satisfies` assertions. Capability browser projection, CLI verification, and
the registered-module client import guard therefore stay aligned with the live
manifest when authors use those type-safe declaration forms.

Unparenthesized function types in those assertions are recognized without
mistaking the `>` in `=>` for a runtime operator. Alias resolution also stops
at real statement boundaries rather than every line break, and only follows
immutable `const` bindings, so multiline expressions and reassigned `let`/`var`
registrations remain opaque instead of projecting or protecting the wrong
module.

Semicolonless aliases remain visible when a TypeScript assertion or a
control-flow statement precedes the exported app. Registry-object alias chains
are now followed only when each binding has a single runtime consumer; directly
or transitively mutated `const` registries stay opaque so browser projection,
verification, and the server-only import guard cannot inspect a stale module
map that differs from the live app. Type-only `typeof` queries do not count as
runtime consumers and therefore preserve safe static extraction.

Generated pages-router guidance now qualifies root request middleware as a
serverful-adapter feature, so pure static-export starters are not instructed to
add unsupported middleware.

The pages middleware generator now refuses pure static-export projects instead
of writing a request middleware file that static builds reject. Verification
also avoids reporting a valid root middleware as successful when another
nested, directory-shaped, or unsupported middleware file blocks the build.
Static-target detection follows the adapter selected in the pracht plugin,
including aliased built-in and literal custom static adapters, without treating
unused imports, comments, or strings as an active static target. Exported
`const` adapter aliases are followed as well.

Manifest registry extraction now recognizes semicolonless aliases before async
function declarations and no longer mistakes commas inside generic type
annotations for later `const` declarators. Capability projection, verification,
and client import protection therefore continue to follow the live manifest in
both forms.

Middleware export validation treats setter-only properties as `undefined`
rather than mistaking the setter function itself for the destructured runtime
value. Getter-backed accessors remain conservatively runtime-defined.

Runtime `typeof registry.member` reads now count as real registry uses because
they can invoke accessors and mutate the module map; type-only and bare-object
queries remain harmless. Middleware bindings assigned at module scope after an
initially undefined declaration stay conservatively runtime-defined instead of
being rejected from the declaration alone.

Static-target detection follows aliased and namespace imports of the pracht
plugin as well as aliased adapter imports. The canonical routing guides now
consistently qualify pages request middleware as a serverful-adapter feature.
Object-property detection also follows JavaScript's last-write-wins semantics
through statically resolvable option spreads, so the middleware generator uses
the adapter that the pracht plugin actually receives.

Ejected-pages ownership detection now preserves the client boundary when the
generated marker is exported through a named export list, including an aliased
local binding. Middleware callable validation keeps initializer snapshots
accurate when a non-callable mutable binding is copied before a later
reassignment, while still accepting aliases created after a module-scope
assignment. The pages middleware generator also follows immutable aliases for
the complete pracht plugin options object before deciding whether the selected
adapter is a pure static target.

Top-level type-alias `typeof` queries of registry members are erased along with
bare registry queries, so they no longer hide otherwise static capability or
middleware registrations from browser projection, verification, or the
registered-module client import guard. The same extraction is preserved for
member queries in interfaces, variable annotations, generic constraints, and
function signatures, including generic and explicitly annotated arrow parameters.
Runtime calls, ternaries, and reserved-word object properties remain observable
uses rather than being mistaken for erased type syntax.

Runtime `typeof` expressions after a semicolonless type alias are still treated
as real registry reads, closing the accessor side-effect gap without regressing
erased multiline type queries. Directly exported middleware function
declarations are also checked for later non-callable assignments before build
and CLI validation accept them.

Static-target detection now follows immutable config objects passed through
`defineConfig`, so the pages middleware generator refuses pure static exports
when the exported Vite configuration is wrapped around a local config alias.

Manifest registry extraction now forgets registrations that precede an
unresolved spread or computed property, while retaining explicit registrations
that follow the opaque write. Shadowing ordinary-function parameters no longer
count as uses of a top-level registry binding. Middleware export validation
also classifies definitely evaluated writes in variable initializers, control
tests, static class fields, and static blocks, without treating instance fields
or method bodies as module-scope writes.

Statically resolvable object spreads now preserve and override manifest module
registrations with normal last-write semantics, while arrow-function parameter
shadowing no longer makes a safe registry opaque. Pages mode consistently
reserves `_app` for the root shell and excludes nested lookalikes from both the
scanner and server registry. Middleware export validation also accounts for
definitely evaluated `try`/`finally` writes and computed destructuring targets.

Ejected pages client boundaries now compare canonical route and shell
directories, so `..` segments and symlink aliases cannot put underscore-reserved
server helpers back into the browser module map. Registry extraction no longer
mistakes braced control statements for parameter-shadowing methods, preventing a
runtime-mutated capability registry from bypassing the registered-module client
guard.

Middleware export validation now covers definitely entered `do`/`while` and
labeled statement bodies and accepts callable TypeScript `import =` runtime
aliases. Pages middleware generation also follows immutable aliases for the
selected Vite plugin array when rejecting request middleware on pure static
exports.

Static analyzers now respect destructured function parameters and nested
lexical bindings that shadow manifest registries or exported middleware names.
Static-target detection also follows immutable aliases of the Pracht and static
adapter factories, preventing request-middleware scaffolding for aliased pure
static configurations.

Middleware export validation now honors explicit-over-star ESM precedence, so
a known non-callable `middleware` export cannot be rescued by an unrelated star
re-export. Manifest registry use tracking preserves executable template
interpolations, distinguishes TypeScript function-type arrows and semicolonless
statement boundaries from runtime arrow scopes, and respects function-scoped
`var` shadows. These cases now fail closed without hiding safe static
registrations.

Semicolonless top-level function type aliases no longer hide a following runtime
registry use, keeping capability projection, verification, and registered-module
client guards aligned with registries that are mutated after the type declaration.

Ejected layouts also preserve the pages shell boundary when route files move to
a separate directory while the root `_app` and underscore-reserved helpers remain
in the original shell directory. Those helpers stay out of browser module globs
during partial migrations.

Statically known computed manifest registry keys now retain their runtime property
names, keeping capability projection and registered-module client guards aligned
with `defineApp()`. Unresolved computed keys continue to fail closed.

The interactive `create-pracht` router prompt now advertises the pages router's
single root `_middleware.ts` support on server adapters instead of describing all
pages middleware as unavailable.

Ejected-pages ownership detection also recognizes the marker when a valid ESM
string-literal export name is used, preserving the client middleware boundary
for quoted named-export aliases.

Middleware export validation now records nested `var` initializers that update
module bindings while respecting switch-wide lexical declarations and the local
`var` scope of class static blocks. Build and CLI verification no longer accept
non-callable middleware exports, or reject callable ones, because of these
evaluation and shadowing boundaries.

Nested module-scoped `var` declarations and implicit `for...in`/`for...of`
assignments now participate in middleware callable analysis without losing the
runtime binding itself. Registry alias extraction recognizes lexical bindings
declared in loop headers, and pages middleware generation resolves nested Vite
config aliases in their actual scope, keeping verification, capability client
boundaries, and static-adapter checks aligned with runtime behavior.

Direct module-level `var` initializers now keep their runtime position in
middleware callable analysis even when an earlier assignment targets the same
binding. Registry extraction recognizes async, generator, and accessor methods
whose parameters shadow a top-level registry, and pages middleware generation
does not mistake a mutable serverful adapter binding for a shadowed static-adapter
import.
