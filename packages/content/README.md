# @pracht/content

An optional, server-only content collection primitive for Pracht applications.
It replaces parallel runtime/build filesystem readers with one registry that
owns route-to-source mapping, locales and fallback, source representations,
compilation memoization, iteration, and static artifacts.

For an official Markdown route-module compiler on top of this primitive, use
[`@pracht/markdown`](../markdown/README.md). It also integrates relative
Markdown images with `@pracht/image` build-time responsive variants.

```sh
pnpm add @pracht/content
```

## Collection

```ts
import {
  defineCollection,
  llmsTxtArtifacts,
  rawContentArtifacts,
} from "@pracht/content";

export const docs = defineCollection({
  name: "docs",
  root: new URL("./content/docs", import.meta.url),
  routeBase: "/docs",
  locales: {
    default: "en",
    supported: ["en", "fr", "nl"],
    // Non-default locales fall back to `en` when omitted.
  },
  compile({ body, frontmatter }) {
    return compileMarkdown(body, frontmatter);
  },
  module(document) {
    return createRouteModule(document);
  },
  artifacts: [
    rawContentArtifacts({ path: (document) => `${document.path}.md` }),
    llmsTxtArtifacts({
      title: "Product docs",
      origin: "https://example.com",
      sections: [{ heading: "Docs", match: "/docs" }],
    }),
  ],
});
```

Without `sources`, the registry scans `root` recursively for `.md` and `.mdx`.
Use an explicit registry when routes should not be inferred:

```ts
defineCollection({
  name: "articles",
  root: new URL("./content", import.meta.url),
  sources: [
    { id: "welcome", path: "/news/welcome", source: "welcome.md" },
    { id: "welcome", path: "/fr/actualites/bienvenue", source: "fr/welcome.md", locale: "fr" },
  ],
  locales: { default: "en", supported: ["en", "fr"] },
});
```

Duplicate `(id, locale)`, `(path, locale)`, source, and artifact registrations
fail before output is emitted. Routes and output paths must be safe,
root-relative URL paths; source paths cannot escape the collection root,
including through an explicitly registered symbolic link. Symbolic collection
roots remain addressable through the canonical module IDs emitted by Vite.

A scan follows symbolic files and directories inside the root and guards
against link cycles. A link whose target leaves the root, or whose target no
longer exists, is skipped rather than failing the collection the way an
explicitly registered escaping link does. A link onto content the scan already
reaches names the same document twice, so the direct path wins and the link
registers no second route.
Custom and explicit locale routes cannot shadow generated fallback aliases,
including aliases for documents with the same id; generated
`routePrefix: "never"` routes may still share one locale-neutral path.

## Documents and lookup

Every loaded document exposes:

```ts
interface ContentDocument<Frontmatter, Compiled> {
  id: string;
  path: string;
  locale?: string;
  source: string;
  relativeSource: string;
  raw: string;
  body: string;
  frontmatter: Frontmatter;
  compiled: Compiled;
}
```

- `all()` and `iterate()` are the build-time traversal API.
- `getByRoute()` and `getById()` return a document with locale fallback.
- `resolveByRoute()` and `resolveById()` additionally report
  `requestedLocale` and whether fallback occurred.
- `getBySource()` and `loadSource()` connect Vite transforms to the same
  registry.
- `invalidate()` clears one source or the complete compilation cache.

String and array locale fallback configuration applies only to non-default
requested locales. Use an explicit fallback record entry when the default
locale should fall back to another locale. Every fallback target must be listed
in `supported`, and every fallback record key must name a supported requested
locale. Invalid fallback configuration is rejected when the collection is
defined. `routePrefix: "never"` keeps translated documents on the same
locale-neutral route; pass a locale to route lookup to select the translation.
Without one, route lookup selects the configured default locale regardless of
its position in `supported` or whether its document exists. An explicit
fallback record can resolve another translation, while `fallback: false`
requires the configured default document itself.
Generated aliases cover only missing locales and use the source selected by
that locale's fallback order. Existing translations with custom slugs do not
gain aliases based on another translation's slug, and two missing locales
cannot collapse onto one callback-generated alias.

The filesystem registry is memoized and rebuilt only after `invalidate()`.
Relative invalidation paths, like source lookup paths, resolve from the
collection root.

The default parser accepts YAML frontmatter. Pass `parse` to use another
format. The default compiled representation is `body`; pass `compile` for HTML,
an AST, a search record, or an application-specific object.

## Vite

```ts
import { prachtContent } from "@pracht/content/vite";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";
import { docs } from "./content";

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), pracht()],
});
```

The first plugin transforms plain collection source imports through the
collection's `module` hook in every Vite environment; resource queries such as
`?raw`, `?url`, `?url&inline`, `?url&no-inline`, `?worker`, and `?sharedworker`
retain Vite's built-in semantics.
The second serves generated artifacts with GET/HEAD beneath Vite's configured
base in development and emits identical static files in client builds.
File watcher events invalidate only the affected memoized document and the
shared route/source index. Every collection root is added to the development
watcher, so a root outside Vite's project root — a monorepo's shared docs
directory, for example — still invalidates on edit. Artifact `contentType` values are carried into
Pracht's production headers manifest and applied by the Node, Cloudflare,
Netlify, and Vercel adapters as well as the development response. Malformed,
non-portable, non-ByteString, or control-character values fail before
publication, and an artifact named
`index.html` keeps its generated headers on its clean URL alias. A collection
artifact at `/llms.txt` cannot be combined with Pracht's core `llmsTxt`
generator; the build rejects that collision instead of overwriting the curated
collection output. OpenAPI companion output is rejected when it would replace
a collection artifact. Artifacts emitted inside an `/assets/` path use a
revalidation cache policy because their filenames are not required to contain a
content hash. Generated artifact paths also cannot overlap files in
Vite's configured `publicDir`, where one output would otherwise replace the
other, or prerendered page files. Portable case-folded and
file/directory collisions fail across collections, and Pracht's entire
`/_pracht` build-output namespace and Netlify's root `/_headers` and
`/_redirects` control paths are reserved, including descendants that would
replace a control file with a directory. Artifacts also cannot occupy exact
request-time page or API paths, including clean-URL `index.html` aliases and
concrete ISG paths served by an adapter function. Vercel header rules escape
literal artifact path characters before applying generated content types.
Artifact paths must use canonical, portable ASCII URL segments without percent
encoding. Spaces, non-ASCII segments, Windows-reserved names, trailing dots,
and filesystem-invalid characters are rejected because deployment adapters
otherwise resolve them to different on-disk names.

During `pracht build`, generated document routes are reconciled against the app
route manifest. Dynamic serverful routes cover matching documents, while a
static export trusts dynamic SSG routes only for concrete `getStaticPaths()`
output and dynamic SPA routes only when the static adapter emits a fallback.
Route order remains authoritative when patterns overlap. The internal manifest
preserves every valid collection name, including prototype-named keys such as
`__proto__`. Configure `unroutedDocuments: "error" | "warn" | "ignore"` on
`prachtContent()` to select the reconciliation policy.
Warnings remain visible on stderr when `pracht build --json` reserves stdout
for the JSON report. Vite's configured `publicDir` cannot occupy the internal
`_pracht/content-manifest.json` build-manifest path, including portable
file/directory collisions, and an already-emitted Vite output cannot occupy it.
This versioned file carries both artifact metadata and generated routes to the
CLI, which consumes it before publication. Register all collections through
one `prachtContent()` call.

For request-time loaders and capabilities, import the generated snapshot rather
than the filesystem-backed authoring collection:

```ts
import docs from "virtual:pracht/content/docs";
```

The suffix is the collection `name`. This module embeds the document and
locale/fallback indexes into the server bundle, so it works in Cloudflare,
Vercel, and dist-only Node deployments without source files or `node:fs`.
Collection names are matched literally, including names containing `%`; an
encoded suffix remains supported when an import cannot spell the name directly.
`prachtContent()` rejects two names when one's literal spelling is the other's
percent-encoded spelling, because both would claim the same virtual module.
The virtual module is server-only: a retained client import fails the build
instead of publishing the collection's source, frontmatter, and compiled data
to browser JavaScript. Keep it inside loaders, middleware, API routes, and
server capabilities.

The snapshot module keeps only lookup metadata. Each document's `raw`, `body`,
and `compiled` representations live in a deferred per-document chunk that is
loaded when an asynchronous collection accessor resolves that document.
`iterate()` loads one document at a time, while `all()` loads the collection.
This keeps the first request to any content-backed route from parsing every
document in a shared server chunk.

The plugin enables server code splitting for webworker builds as well. Deferred
content payloads remain one module per document, and lazy route modules keep
their own chunks: a chunk is an evaluation unit, so packing unrelated lazy roots
together would run every one of their module bodies the first time any of them
is imported. A Cloudflare deployment must preserve Pracht's
pre-bundled output with `"no_bundle": true` and an `ESModule` rule covering
`"**/*.js"` in `wrangler.jsonc`; otherwise Wrangler either bundles the deferred
chunks again or omits them from the upload. New `create-pracht` projects include
both settings, and `pracht verify` warns when either is missing.

Those payload chunks still carry roughly two to three times the source content.
An application that neither negotiates Markdown nor searches bodies can drop
either representation entirely:

```ts
defineCollection({
  name: "docs",
  root: new URL("./content/docs", import.meta.url),
  // Both default to true. The authoring collection keeps every field.
  snapshot: { raw: false },
});
```

An omitted field is absent on snapshot documents. Generated modules expose a
lookup-only `ContentSnapshotCollection`; its `ContentRuntimeDocument` type
makes `raw` and `body` optional. The filesystem-backed authoring
`ContentCollection` keeps required source fields and the compiler/artifact
lifecycle. `collection.snapshotFields` reports what a runtime registry carries.
`markdownRepresentation()` needs `raw` (or `body`) and throws an actionable
error when the selected representation was omitted. Both capability helpers
need `body`; building one over a body-free snapshot throws where the capability
is wired up rather than answering every query with nothing.

Frontmatter and compiled values used this way must be JSON-serializable. JSON
object keys retain their data semantics in the generated module, including
prototype-named keys such as `__proto__`; sparse arrays are rejected rather
than silently changing their holes to `null`. Add `@pracht/content/virtual` to
`compilerOptions.types` for the generic ambient module declaration, or augment
the module locally with application-specific frontmatter and compiled types.

## Loaders and Markdown negotiation

Import request-time helpers from the filesystem-free runtime entry:

```ts
import { contentLoader, markdownRepresentation } from "@pracht/content/runtime";
```

`contentLoader()` turns snapshot lookup into a Pracht-compatible structural
loader without making `@pracht/core` a dependency. It uses Pracht's matched,
base-free loader `pathname` by default; structural callers outside Pracht can
provide `pathname` or override `path`. Use `select` to keep loader data
serializable and small. A pathname a dynamic route matched but no document can
carry — `/docs/%2e%2e`, an encoded NUL, a backslash segment — takes the same
404 path as a missing document instead of failing the request. A locale selected
from loader arguments does too when the collection does not support it.
`markdownRepresentation(document, "raw" | "body")`
selects the string a generated route module can export as its server-only
`markdown` representation.

## Optional agent surfaces

`llmsTxtArtifacts()` is collection-driven and can generate curated sections
and a full-source companion. It is separate from Pracht's core, app-graph
`llmsTxt` option.
Frontmatter titles are escaped when used as Markdown link labels, and YAML line
breaks in titles or descriptions are folded so each document remains one
summary entry. Link destinations escape parentheses and backslashes so valid
route characters cannot terminate the generated URL early.

`@pracht/content/capabilities` exports `createContentPageCapability()` and
`createContentSearchCapability()`. They return the `input`, `output`, and `run`
fields for an app-owned capability:

```ts
import { defineCapability } from "@pracht/capabilities";
import { createContentPageCapability } from "@pracht/content/capabilities";
import docs from "virtual:pracht/content/docs";

const page = createContentPageCapability(docs);

export default defineCapability({
  title: "Read docs page",
  description: "Return one public documentation page by route.",
  effect: "read",
  input: page.input,
  output: page.output,
  run: page.run,
  // expose, middleware, and agentPolicy remain explicit app policy.
});
```

Keeping the literal `defineCapability({ ... })` in the application lets
`pracht verify` statically audit its trust and exposure policy. With no
`expose`, the capability remains private. The search helper is intentionally
basic and dependency-free; applications needing stemming, ranking, or a
persistent index should consume `collection.iterate()` from their search
backend instead. The page helper advertises configured locales in its schema
and returns `found: false` for malformed routes or unsupported locales. The
search helper advertises the same locale constraint for localized collections
and does not filter an unlocalized collection when a locale hint is supplied.

See the full framework guide at [docs/CONTENT.md](../../docs/CONTENT.md).
