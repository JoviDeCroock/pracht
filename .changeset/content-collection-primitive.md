---
"@pracht/content": minor
"@pracht/core": minor
"@pracht/cli": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/image": minor
"@pracht/markdown": minor
"@pracht/test": minor
---

Add the opt-in, server-only `@pracht/content` collection primitive. One
canonical registry now provides source discovery or explicit route/source
mapping, locale-aware fallback, raw/frontmatter/body/compiled representations,
per-source memoization, deterministic build iteration, loader and Markdown
helpers, and validated static asset generation. Its Vite integration reuses the
same registry for route-module transforms, watcher invalidation, live dev
assets, and client build output.
Virtual collection imports match literal names before decoding an encoded
specifier, so names containing `%` remain addressable and malformed unmatched
escapes fail closed instead of throwing during Vite resolution.

Curated `llms.txt`/`llms-full.txt`, raw-source assets, and app-owned
page/basic-search capability fields are opt-in helpers rather than core
framework policy. String `llms.txt` section matches use locale-neutral routes so
localized documents are not silently omitted, while match callbacks can still
select one locale deliberately. Artifact helper options are validated where
they are configured, and generator failures identify their collection and
`artifacts[n]` position. The docs application now proves the integration by
compiling its Markdown routes and generating both LLM artifacts from the
collection; the old second filesystem/manifest reader has been removed.

Explicit registries now leave unregistered Markdown sources available to other
Vite plugins, locale-neutral id lookups retain the configured default locale,
`routePrefix: "never"` collections allow translations to share one route, and
locale-neutral route lookups select the configured default regardless of
`supported` ordering. Generated aliases cover only missing locales, follow the
configured fallback source, and reject callback or explicit route collisions,
including same-id translations and aliases where multiple missing locales
would otherwise collapse onto one path. Development artifact failures no
longer block unrelated Vite or application requests.

Production builds now reconcile every generated collection route with the
resolved app manifest and report unserved documents with their route,
collection, and source. The policy defaults to `"warn"`, with `"error"` and
`"ignore"` options for strict builds and data-only collections. Dynamic and
catch-all routes are supported; static exports trust only concrete dynamic SSG
output and SPA routes backed by a static fallback, while preserving route
precedence. The prototype-safe internal manifest is consumed before client
output is published. JSON builds keep warnings on stderr, and public files,
earlier Vite output, or multiple plugin instances cannot silently replace the
internal content manifests. Static verification identifies the registry and
defers exact source ownership to this build-time reconciliation.

Add `@pracht/markdown`, the official collection compiler for Markdown route
modules, together with cached `?pracht&pracht-static` responsive WebP variants
and reusable plain image props in `@pracht/image`. Relative Markdown images are
resolved as sibling Vite imports and rendered as hydration-free `<img>` markup;
SVG and animated originals retain their encoded format, and server-only graph
assets are published to the client output, including root-level Vite asset
directories. The package also publishes `@pracht/markdown/client` declarations
for `*.md` and `*.markdown` route modules, and compiled modules default their
head to non-empty `title` frontmatter when no explicit head hook is configured.

Harden the complete authoring and deployment path: cache registry indexes,
invalidate changed, added, and removed sources through lexical or symbolic
collection roots, and preserve prototype-named data in JSON-validated,
filesystem-free runtime snapshots. Locale fallback remains explicit for the
default locale, malformed capability lookups fail closed, and empty YAML
frontmatter is accepted.

Generated artifacts now carry content types across Node, Cloudflare, Netlify,
and Vercel through adapter-native routing; preserve Vite `?raw`, `?url`,
`?inline`, `?no-inline`, `?worker`, and `?sharedworker` resource-query imports;
and reject collisions
with public files, generated bundle output, prerendered pages, exact
request-time page or API paths, clean-URL `index.html` aliases, concrete ISG
paths served by adapter functions, core `llms.txt`, OpenAPI output, other
case-folded or parent/child artifacts, Pracht's `/_pracht` namespace, and
Netlify's root `/_headers` and `/_redirects` control files, including
descendants that would turn those required files into directories. Artifact
filenames must be portable and canonical, while Vercel header routes escape
literal artifact path syntax. Netlify also applies exact generated headers to
bypassed static paths and skips wildcard or placeholder manifest entries rather
than broadening generated header rules.
Locale fallback records ignore prototype-inherited keys, and Markdown image
markers remain stable when identical projects are built from different checkout
paths. Locale fallback targets are validated before collection snapshots are
emitted; record keys must also name supported requested locales. Explicit routes
cannot silently shadow generated locale aliases. Content search ignores locale
hints for unlocalized collections while advertising supported locales for
localized ones. Artifact content types are validated before entering response or
deployment headers, and generated headers remain intact on clean URL aliases for
artifact `index.html` files.
Loader, API, middleware, MCP capability dispatch, and first-party test factory
arguments use Pracht's matched base-free pathname, including app-level
not-found loaders; development artifacts honor Vite's configured deployment
base, locale alias collisions include the target locale, and artifact content
types must parse as portable HTTP media types that can be represented by Web
response headers. Capability HTTP middleware also receives the canonical
matched path when a request uses the accepted trailing slash.
Artifacts inside an `/assets/` path override adapter-wide immutable caching with
a revalidation policy because their filenames are not required to contain a
content hash.

Content collections also reject explicit sources and resolved symbolic links on
another Windows drive because those paths are outside the collection root.

Unprocessed `publicDir` static image imports now bypass configured runtime
loaders, and Markdown preserves custom Marked image renderers for root-relative,
remote, and data image sources. Netlify builds preserve hand-authored `_headers`
files copied from the configured Vite public directory without allowing an
unused default `public/_headers` to suppress generated deployment headers.

Shared pass-through static images now keep a live backing source when another
identical SVG or animated image is edited or removed during development.

Netlify builds no longer fail on prerendered page paths that `_headers` cannot
express as an exact match (a `*` or leading-`:` segment): header-less entries
are skipped, entries with headers are skipped with a build warning naming the
path, and malformed header names or values still fail the build. `contentLoader()`
treats malformed request pathnames as not-found instead of throwing, matching
the capability helpers.

Static image variants clamp encoding to WebP's 16383-pixel limit on both axes,
including extreme portraits that cannot shrink below one pixel wide, instead
of failing the build on very large sources. `staticWidths` validation rejects
widths above that limit, and encoder failures name the offending source file.
The image disk cache is pruned of entries unused for 30 days, cache hits keep
live entries fresh, edited sources evict their stale in-memory variants, and
variant bytes are read lazily from the cache at emission instead of being held
in memory for the whole build.

Build-time route reconciliation now includes generated locale fallback aliases
and reports them with the source file that supplies the fallback. Content
loaders route unsupported locale values through their configured not-found
response instead of surfacing a collection lookup error.

Markdown images without a configured `sizes` now inherit `@pracht/image`'s
intrinsic-width default instead of `100vw`, and the unreachable markdown
`quality` option is removed. The Markdown trust model — compiled output is
executed as HTML; feed it only trusted content — is now documented.

Collections accept `snapshot: { raw?, body? }` to choose which source
representations runtime snapshots embed, forwarded by
`defineMarkdownCollection()`. The default embeds `body` but not `raw`:
compiled route modules and build-time artifact generators already carry the
exact source, so duplicating it in the server bundle is opt-in via
`snapshot: { raw: true }`. Capability helpers that need a trimmed field fail
at construction with an actionable error, and `markdownRepresentation()`
rejects a selected representation that the snapshot omitted. Scanned collections follow in-root symbolic links
(escaping or dangling links are skipped), collection roots outside Vite's
watched root are added to the dev watcher, and the authoring and snapshot
runtimes share one locale and route-path implementation.
