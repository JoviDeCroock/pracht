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
`?raw` and `?url` retain Vite's built-in semantics. The second serves generated artifacts
with GET/HEAD beneath Vite's configured base in development and emits identical
static files in client builds.
File watcher events invalidate only the affected memoized document and the
shared route/source index. Artifact `contentType` values are carried into
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

For request-time loaders and capabilities, import the generated snapshot rather
than the filesystem-backed authoring collection:

```ts
import docs from "virtual:pracht/content/docs";
```

The suffix is the collection `name`. This module embeds the documents and
locale/fallback indexes into the server bundle, so it works in Cloudflare,
Vercel, and dist-only Node deployments without source files or `node:fs`.
Frontmatter and compiled values used this way must be JSON-serializable. JSON
object keys retain their data semantics in the generated module, including
prototype-named keys such as `__proto__`. Add `@pracht/content/virtual` to
`compilerOptions.types` for the generic ambient module declaration, or augment
the module locally with application-specific frontmatter and compiled types.

## Loaders and Markdown negotiation

`contentLoader()` turns snapshot lookup into a Pracht-compatible structural
loader without making `@pracht/core` a dependency. It uses Pracht's matched,
base-free loader `pathname` by default; structural callers outside Pracht can
provide `pathname` or override `path`. Use `select` to keep loader data
serializable and small. `markdownRepresentation(document, "raw" | "body")`
selects the string a generated route module can export as its server-only
`markdown` representation.

## Optional agent surfaces

`llmsTxtArtifacts()` is collection-driven and can generate curated sections
and a full-source companion. It is separate from Pracht's core, app-graph
`llmsTxt` option.

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
