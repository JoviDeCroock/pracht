# Content Collections

`@pracht/content` is the optional server-only content layer for applications
whose loaders, route transforms, build plugins, and agent surfaces need to read
the same documents. It is deliberately outside `@pracht/core`: content policy,
Markdown rendering, public artifacts, and search exposure remain application
choices.

## Why a companion package

A content-heavy app otherwise tends to grow two implementations:

1. route/server code reads source through Vite's module graph;
2. sitemap, asset, search, or `llms.txt` plugins scan the filesystem again.

Those readers drift on route mapping, frontmatter, locales, fallback, and cache
invalidation. A collection is the single registry both sides consume. The docs
example now uses it for Markdown route modules and curated `llms.txt` plus
`llms-full.txt`; the former manifest-scanning `vite-plugin-llms-txt.ts` reader
has been removed.

## Boundary

The package owns:

- source discovery or an explicit source registry;
- stable id, public route, source, and locale indexes;
- default-locale fallback with an explicit no-fallback lookup;
- exact raw source, parsed YAML frontmatter/body, and an application-defined
  compiled value;
- per-source compilation memoization and Vite watcher invalidation;
- a portable Vite-generated snapshot for request-time server consumers;
- deterministic async build iteration;
- validated static artifact generation and matching dev endpoints;
- small adapters for Pracht loaders and route Markdown exports.

The package does not own:

- Preact page structure or an application-specific Markdown/MDX renderer;
- route authorization or loader response caching;
- which collection is public;
- core app-graph `llms.txt` policy;
- search indexing policy or capability exposure.

This boundary keeps the package useful for blogs, help centers, changelogs, and
product catalogs without turning those conventions into framework defaults.

## Official Markdown integration

`@pracht/markdown` is the opt-in, opinionated integration for applications
that do want a supported Markdown route-module compiler. It wraps
`defineCollection()`, uses `marked` by default, exposes hooks for renderer,
page markup, head, and artifacts, and keeps raw Markdown available to Pracht's
content negotiation.

Compiled Markdown is executed as HTML without sanitization — the build-time
trust model. Only feed it trusted, repo-authored content; sanitize CMS- or
user-sourced Markdown in `parse` or `render` before it compiles. See the
[`@pracht/markdown` trust model](../packages/markdown/README.md#trust-model).

```ts
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
import { defineMarkdownCollection } from "@pracht/markdown";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
});

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), prachtImage(), pracht()],
});
```

Relative Markdown images are compiled to source imports using
`?pracht&pracht-static`. With `prachtImage()` registered, the generated route
module receives intrinsic dimensions and cached, content-hashed WebP variants.
The final output is plain `<img>` markup with `srcset` and `sizes`, so it works
for SSR, SSG, and `hydration: "none"` without a client Markdown or image
runtime. Root-relative `public/`, remote, and data URLs remain unchanged.
Custom Marked image renderers continue to handle those unprocessed sources.
Vite resource queries such as `?raw`, `?url`, `?url&inline`,
`?url&no-inline`, `?worker`, and `?sharedworker` also retain their normal Vite
semantics instead of being claimed by the collection route-module transform.

## Registry and paths

`defineCollection()` accepts an absolute `root`. It recursively discovers
`.md`/`.mdx` by default, or accepts explicit `{ id, path, source, locale }`
entries. Generated routes use `routeBase`, collapse `index` files to their
directory, and can be replaced with a `route(context)` callback.

All route and artifact paths are canonical, safe root-relative URL paths.
Source paths are resolved under `root`; traversal outside it is rejected.
Explicit sources are checked again after symbolic links are resolved, so a
link inside the collection cannot read or publish a file outside the root. A
symbolic collection root is supported: canonical module IDs still resolve to
the registered source.

Discovery follows symbolic files and directories under the root and stops when
a link points back at a directory it is already inside. The containment rule is
unchanged, but discovery applies it differently from registration: an escaping
or dangling link found by a scan is incidental, so it is skipped instead of
failing the collection the way a deliberately registered one does. A link that
only re-exposes content the scan already reaches resolves to the direct path,
which keeps one file from claiming two routes.
Ambiguous source, route/locale, id/locale, and artifact registrations throw
instead of letting ordering select a winner. Custom or explicit locale routes
also cannot shadow a missing locale's generated fallback alias, even when both
documents share an id, and two missing locales cannot collapse onto one
callback-generated alias. Generated `routePrefix: "never"` routes remain the
intentional locale-neutral exception and need no aliases because direct route
lookup applies the requested locale's fallback.

## Locales

With `locales.sourceDirectories` (the default), a supported first directory
segment becomes the source locale:

```text
content/docs/en/guide.md  -> id guide, locale en, /docs/guide
content/docs/fr/guide.md  -> id guide, locale fr, /fr/docs/guide
```

The default route prefix strategy omits the default locale and prefixes every
other locale. Use `routePrefix: "always" | "never"` or explicit source paths
for another URL policy. With `"never"`, translated documents intentionally
share one locale-neutral route; pass `locale` to a lookup to select the desired
translation. Omitting it selects the configured default locale, regardless of
where that locale appears in `supported` or whether its document exists. An
explicit fallback record can then resolve another translation; setting
`fallback: false` still requires the configured default document itself.

`getById()`/`getByRoute()` fall back to the default locale by default.
`fallback: false` requests an exact locale. The `resolve*` variants report
fallback explicitly and keep the returned document's real locale intact; code
must not pretend fallback source is translated content. String and array
`fallback` configuration applies only to non-default requested locales. Use an
explicit record entry when the default locale should fall back to another
locale. Every configured fallback target must also appear in `supported`;
fallback record keys must name a supported requested locale too. Invalid
fallback configuration is rejected when the collection is defined.
Generated route aliases are created only for locales that do not have a
document, using the document that locale fallback would actually select. A
translated document with its own custom slug therefore does not inherit the
other translations' slugs.

## Representations and memoization

The built-in YAML parser produces `frontmatter` and `body`, while `raw` always
retains the exact original source. `compile(input)` may return any value: HTML,
an AST, a page model, or a search record. Filesystem loads reuse compilation
while mtime and size are unchanged. Vite supplies the live transformed source
and clears the affected entry plus the cached registry on add/change/unlink.
Every collection root joins the development watcher, so a root outside Vite's
own project root still reports those events. Repeated lookups otherwise reuse
the same route/source index instead of rescanning the collection root.

Failed parsing or compilation is never cached. The next request/build retries,
which keeps a temporary authoring error from poisoning the development server.

`contentLoader()` uses the framework's matched, base-free loader `pathname` by
default, so collection routes stay independent of the configured deployment base.
A dynamic route such as `/docs/:slug` also matches pathnames no document can
carry, like `/docs/%2e%2e`; the loader answers those with its not-found path
rather than surfacing the route rejection as a request failure. A `locale`
selected from loader arguments takes the same path when it is not supported by
the collection.

## Static artifacts

Collection-level artifact generators receive the already-loaded, sorted
document list. `prachtContent()` serves their output live in development beneath
Vite's configured deployment base and emits the same bytes during the client
build. `rawContentArtifacts()` and
`llmsTxtArtifacts()` cover common cases; a custom generator can emit JSON,
XML, Markdown, or binary `Uint8Array` content.
Frontmatter titles used as `llms.txt` link labels escape Markdown brackets, and
titles or descriptions containing YAML line breaks are folded into one line so
one document cannot create extra summary entries accidentally.
Explicit artifact content types are preserved in the production headers
manifest and applied to static assets by the Node, Cloudflare, Netlify, and
Vercel adapters as well as development responses. Malformed, non-portable,
non-ByteString, or control-character content types fail before they can enter a
response or deployment manifest, and
an artifact named `index.html` keeps those headers on its clean URL alias.
Artifacts emitted inside an `/assets/` path receive a revalidation cache policy
because their filenames are not required to contain a content hash. If Pracht's core `llmsTxt` option is
also enabled, a collection using the default `/llms.txt` path fails the build
instead of being silently overwritten; configure a distinct `summaryPath` or
use only one generator. OpenAPI companion output is checked the same way rather
than replacing a collection artifact. Artifact output is preflighted before publication:
case-folded and file/directory collisions fail across collections, Pracht's
entire `/_pracht` build-output namespace and Netlify's root `/_headers` and
`/_redirects` control paths are reserved, including descendants that would turn
a required control file into a directory, and artifacts cannot overlap files in
Vite's configured `publicDir`, generated bundle output, prerendered page output,
exact request-time page or API paths, or concrete ISG paths whose snapshots are
served by an adapter function. Vercel header rules
escape literal artifact path characters before applying generated content
types.
Artifact paths must use canonical, portable ASCII URL segments without percent
encoding. Spaces, non-ASCII segments, Windows-reserved names, trailing dots, and
filesystem-invalid characters are rejected because deployment adapters
otherwise resolve them to different on-disk names.

Artifacts are opt-in. In particular, adding a collection does not publish raw
source or create an agent surface.

Helper options are validated when the generator is defined rather than when it
runs, and a generator that throws is reported with its collection name and
`artifacts[n]` position — a failure inside a Vite build hook otherwise names
neither.

`llmsTxtArtifacts()` matches a string `section.match` against the
**locale-neutral** route. A localized collection prefixes its translations
(`/fr/docs/guide`), so the natural `match: "/docs"` would otherwise index only
the default locale while `rawContentArtifacts()` published every translation —
one registry, two artifacts, silently different coverage. Pass a `match`
function to index a single locale deliberately. Link destinations escape
parentheses and backslashes so every valid route remains one exact Markdown URL.

## Route reconciliation

A collection discovers sources from the filesystem, while routes are registered
by hand in the app manifest. Those are two readers, and a source added without a
matching route still reaches every artifact generator: `llms.txt` advertises a
URL, `rawContentArtifacts()` publishes its source, and the page itself answers
404.

`pracht build` therefore reconciles the two. `prachtContent()` hands the CLI the
routes its registry generates, the CLI matches them against the resolved app
routes — including dynamic and catch-all patterns — and reports every document
or generated locale fallback alias no route serves, naming its route,
collection, and source file. The channel is
an internal build file that is consumed and deleted before the client output is
published. For a static export, a dynamic SSG pattern only serves the concrete
paths returned by `getStaticPaths()`; an omitted document is still reported
because the deployed files cannot answer it. Dynamic serverful routes continue
to cover their matching document paths. A dynamic SPA route covers static
deep links only when `staticAdapter({ fallback })` emits a fallback document;
without one, those URLs answer 404. Route order remains authoritative, so a
later SPA fallback cannot rescue a document shadowed by an earlier dynamic SSG
route that did not prerender it.

The default policy is `"warn"`. Use `"error"` to fail the build, or `"ignore"`
for a data-only collection whose documents are deliberately never pages:

```ts
prachtContent({ collections: [docs], unroutedDocuments: "error" });
```

With `pracht build --json`, reconciliation warnings are written to stderr so
stdout remains valid machine-readable JSON. Vite's configured `publicDir`
cannot contain `_pracht/content-manifest.json` (including portable
file/directory collisions), and an already-emitted Vite output cannot occupy
that path. The versioned manifest is the plugin's single artifact-and-route
contribution to the CLI and is deleted before publication. Register all
collections through one `prachtContent()` call.

`pracht verify` cannot perform this check: it reads the Vite config as text and
cannot resolve which sources a registry claims. It reports the presence of a
registry and defers the precise answer to the build.

## Runtime snapshots

The collection imported by `vite.config.ts` is an authoring/build object backed
by the source filesystem. Server loaders and capabilities should instead import
the generated module for that collection name:

```ts
import docs from "virtual:pracht/content/docs";
```

`prachtContent()` serializes the documents, locale fallback configuration, and
route aliases into that module. The deployed server therefore performs lookup
without `node:fs` or a copied source tree on Cloudflare, Vercel, and Node.
The virtual-module suffix matches the collection name literally, including `%`;
an encoded suffix remains supported when an import cannot spell the name
directly. Two collection names cannot use literal and percent-decoded spellings
of the same suffix, because those would make one snapshot inaccessible.
Virtual collection modules are server-only. Importing one from retained client
code fails the build before its source, frontmatter, or compiled values can be
embedded in a browser bundle; keep imports inside loaders, middleware, API
routes, and server capabilities.
Compiled and frontmatter values included in a runtime snapshot must be
JSON-serializable; a build fails with the offending value path otherwise. JSON
object keys retain their data semantics in the generated module, including
prototype-named keys such as `__proto__`. Sparse arrays fail the build rather
than being serialized with their holes changed to `null`.

Each document embeds `raw`, `body`, and `compiled`, so a snapshot costs roughly
two to three times the content it describes. `defineCollection({ snapshot: {
raw: false, body: false } })` drops either representation from the generated
module; both default to true and the authoring collection always keeps them.
The option is deliberately narrow: `compiled` is what routes render, and
frontmatter is what they index, so neither can be dropped.

An omitted field is absent on the snapshot's documents rather than a throwing
accessor, matching the plain object shape the rest of the runtime API returns.
Generated modules expose a lookup-only `ContentSnapshotCollection`, and their
`ContentRuntimeDocument` type makes `raw` and `body` optional; the
filesystem-backed authoring `ContentCollection` retains required source fields
plus compilation, artifact, snapshot, and invalidation methods.
`collection.snapshotFields` reports what a runtime registry carries. Because a
missing representation can still be overlooked at runtime — Markdown
negotiation returns nothing, search matches nothing —
`markdownRepresentation()` rejects a missing selected field, and both
capability helpers reject a body-free collection when the capability is
constructed rather than when it runs.

Request-time loader and Markdown helpers are exported from the same node-free
runtime entry used by generated modules:

```ts
import { contentLoader, markdownRepresentation } from "@pracht/content/runtime";
```

Applications can add `@pracht/content/virtual` to `compilerOptions.types` for a
generic declaration and optionally augment their named virtual module with
more specific document types.

## Optional capabilities

The separate `@pracht/content/capabilities` entrypoint keeps
`@pracht/capabilities` out of applications that only need content. Its page and
basic search factories return `input`, `output`, and `run` fields. The
application wraps those fields in its own literal `defineCapability({ ... })`
call, so `pracht verify` can still statically audit the title, read effect,
middleware, exposure, and agent identity policy. Omitting `expose` keeps the
capability private.

The page helper constrains configured locales in its input schema and treats
malformed routes or unsupported locales as a missing result rather than an
execution failure.

The basic search helper scores title matches above body matches and requires
every query term. Both helpers read `document.body`, so a collection whose
snapshot omits it is refused when the helper is called. Localized collections advertise their supported locales in
the input schema, while locale hints do not filter unlocalized collections. It
is an integration example and a useful small-site default, not a mandatory
search architecture. Larger sites should build an index by iterating the same
collection registry.

See [packages/content/README.md](../packages/content/README.md) for the API and
[the public guide](../examples/docs/src/routes/docs/content.md) for an app-level
walkthrough.
