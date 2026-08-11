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
- deterministic async build iteration;
- validated static artifact generation and matching dev endpoints;
- small adapters for Pracht loaders and route Markdown exports.

The package does not own:

- Preact page structure or a Markdown/MDX renderer;
- route authorization or loader response caching;
- which collection is public;
- core app-graph `llms.txt` policy;
- search indexing policy or capability exposure.

This boundary keeps the package useful for blogs, help centers, changelogs, and
product catalogs without turning those conventions into framework defaults.

## Registry and paths

`defineCollection()` accepts an absolute `root`. It recursively discovers
`.md`/`.mdx` by default, or accepts explicit `{ id, path, source, locale }`
entries. Generated routes use `routeBase`, collapse `index` files to their
directory, and can be replaced with a `route(context)` callback.

All route and artifact paths are canonical, safe root-relative URL paths.
Source paths are resolved under `root`; traversal outside it is rejected.
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
must not pretend fallback source is translated content.

## Representations and memoization

The built-in YAML parser produces `frontmatter` and `body`, while `raw` always
retains the exact original source. `compile(input)` may return any value: HTML,
an AST, a page model, or a search record. Filesystem loads reuse compilation
while mtime and size are unchanged. Vite supplies the live transformed source
and clears the affected entry on add/change/unlink.

Failed parsing or compilation is never cached. The next request/build retries,
which keeps a temporary authoring error from poisoning the development server.

## Static artifacts

Collection-level artifact generators receive the already-loaded, sorted
document list. `prachtContent()` serves their output live in development and
emits the same bytes during the client build. `rawContentArtifacts()` and
`llmsTxtArtifacts()` cover common cases; a custom generator can emit JSON,
XML, Markdown, or binary `Uint8Array` content.

Artifacts are opt-in. In particular, adding a collection does not publish raw
source or create an agent surface.

## Optional capabilities

The separate `@pracht/content/capabilities` entrypoint keeps
`@pracht/capabilities` out of applications that only need content. Its page and
basic search factories return `input`, `output`, and `run` fields. The
application wraps those fields in its own literal `defineCapability({ ... })`
call, so `pracht verify` can still statically audit the title, read effect,
middleware, exposure, and agent identity policy. Omitting `expose` keeps the
capability private.

The basic search helper scores title matches above body matches and requires
every query term. It is an integration example and a useful small-site default,
not a mandatory search architecture. Larger sites should build an index by
iterating the same collection registry.

See [packages/content/README.md](../packages/content/README.md) for the API and
[the public guide](../examples/docs/src/routes/docs/content.md) for an app-level
walkthrough.
