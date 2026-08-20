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
Vite resource queries such as `?raw` and `?url` also retain their normal Vite
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
Ambiguous source, route/locale, id/locale, and artifact registrations throw
instead of letting ordering select a winner.

## Locales

With `locales.sourceDirectories` (the default), a supported first directory
segment becomes the source locale:

```text
content/docs/en/guide.md  -> id guide, locale en, /docs/guide
content/docs/fr/guide.md  -> id guide, locale fr, /fr/docs/guide
```

The default route prefix strategy omits the default locale and prefixes every
other locale. Use `routePrefix: "always" | "never"` or explicit source paths
for another URL policy.

`getById()`/`getByRoute()` fall back to the default locale by default.
`fallback: false` requests an exact locale. The `resolve*` variants report
fallback explicitly and keep the returned document's real locale intact; code
must not pretend fallback source is translated content. String and array
`fallback` configuration applies only to non-default requested locales. Use an
explicit record entry when the default locale should fall back to another
locale. Every configured fallback target must also appear in `supported`;
invalid fallback configuration is rejected when the collection is defined.

## Representations and memoization

The built-in YAML parser produces `frontmatter` and `body`, while `raw` always
retains the exact original source. `compile(input)` may return any value: HTML,
an AST, a page model, or a search record. Filesystem loads reuse compilation
while mtime and size are unchanged. Vite supplies the live transformed source
and clears the affected entry plus the cached registry on add/change/unlink.
Repeated lookups otherwise reuse the same route/source index instead of
rescanning the collection root.

Failed parsing or compilation is never cached. The next request/build retries,
which keeps a temporary authoring error from poisoning the development server.

## Static artifacts

Collection-level artifact generators receive the already-loaded, sorted
document list. `prachtContent()` serves their output live in development and
emits the same bytes during the client build. `rawContentArtifacts()` and
`llmsTxtArtifacts()` cover common cases; a custom generator can emit JSON,
XML, Markdown, or binary `Uint8Array` content.
Explicit artifact content types are preserved in the production headers
manifest and applied to static assets by the Node, Cloudflare, Netlify, and
Vercel adapters as well as development responses. Invalid or control-character
content types fail before they can enter a response or deployment manifest, and
an artifact named `index.html` keeps those headers on its clean URL alias.
Artifacts emitted inside an `/assets/` path receive a revalidation cache policy
because their filenames are not required to contain a content hash. If Pracht's core `llmsTxt` option is
also enabled, a collection using the default `/llms.txt` path fails the build
instead of being silently overwritten; configure a distinct `summaryPath` or
use only one generator. OpenAPI companion output is checked the same way rather
than replacing a collection artifact. Artifact output is preflighted before publication:
case-folded and file/directory collisions fail across collections, Pracht's
entire `/_pracht` build-output namespace and Netlify's root `/_headers` and
`/_redirects` control files are reserved, and artifacts cannot overlap files in
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
Compiled and frontmatter values included in a runtime snapshot must be
JSON-serializable; a build fails with the offending value path otherwise. JSON
object keys retain their data semantics in the generated module, including
prototype-named keys such as `__proto__`.

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
every query term. Localized collections advertise their supported locales in
the input schema, while locale hints do not filter unlocalized collections. It
is an integration example and a useful small-site default, not a mandatory
search architecture. Larger sites should build an index by iterating the same
collection registry.

See [packages/content/README.md](../packages/content/README.md) for the API and
[the public guide](../examples/docs/src/routes/docs/content.md) for an app-level
walkthrough.
