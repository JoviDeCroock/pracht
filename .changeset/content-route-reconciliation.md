---
"@pracht/content": minor
"@pracht/markdown": minor
"@pracht/cli": patch
---

Reconcile content collections against the app route manifest, and close the
authoring gaps found while dogfooding the collection primitive.

A collection discovers sources from the filesystem while routes are registered
by hand, so those remained two readers that could disagree. A source added
without a matching route still reached every artifact generator: `llms.txt`
advertised the URL, `rawContentArtifacts()` published the source, and the page
answered 404 — with a clean build. `prachtContent()` now hands `pracht build`
the routes its registry generates, the CLI matches them against the resolved app
routes including dynamic and catch-all patterns, and every unserved document is
reported with its route, collection, and source file. The channel is an internal
build file consumed and deleted before the client output is published. The
policy defaults to `"warn"`; `unroutedDocuments: "error" | "ignore"` selects a
failing build or exempts a data-only collection. Static exports now count only
the concrete `getStaticPaths()` output of dynamic SSG routes, so a document that
was not actually prerendered is still reported. Dynamic SPA routes count only
when the static adapter emits a fallback, and route precedence is preserved
when an earlier dynamic SSG route shadows a later SPA catch-all. Prototype-named
collection keys such as `__proto__` are preserved in the internal route
manifest instead of disappearing during serialization.
JSON build reports now keep reconciliation warnings visible on stderr, and the
build rejects configured public-directory files that could replace the
internal content headers or route manifests before the CLI validates them.

Localized custom routes no longer produce the Cartesian product of every
translation's slug and every supported locale. Route aliases are emitted only
for missing locales and use the document that locale fallback would actually
select. Routes returned by a collection's `route()` callback now participate in
generated-alias collision checks, so a configured translation cannot silently
shadow another document's fallback URL, including when both translations share
the same document id.

The content Vite transform now preserves `?worker` and `?sharedworker` imports
alongside `?raw` and `?url`, rather than recompiling Vite's generated worker
wrapper as a collection route module.

`llmsTxtArtifacts()` now matches a string `section.match` against the
locale-neutral route. A localized collection prefixes translations, so the
natural `match: "/docs"` previously indexed only the default locale while
`rawContentArtifacts()` published every translation — one registry, two
artifacts, silently different coverage. A `match` function still selects a
single locale deliberately.

Artifact helper options are validated where they are written instead of failing
as a bare `TypeError` inside a Vite build hook, and a throwing generator is
attributed to its collection and `artifacts[n]` position.

`@pracht/markdown` publishes `@pracht/markdown/client` with the `*.md` and
`*.markdown` route-module declarations, so a manifest entry no longer needs a
hand-written ambient module to typecheck. Compiled modules also default their
head to the document's `title` frontmatter — the field `llmsTxtArtifacts()`
already indexes — when no `head()` hook is configured.

`pracht verify` no longer tells apps using `prachtContent()` that their Markdown
routes fail at request and build time. Config text cannot reveal which sources a
registry claims, so the check reports the registry and defers the precise answer
to the build, which resolves it.
