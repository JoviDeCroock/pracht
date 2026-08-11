# @pracht/content

An optional, server-only content collection primitive for Pracht applications.
It replaces parallel runtime/build filesystem readers with one registry that
owns route-to-source mapping, locales and fallback, source representations,
compilation memoization, iteration, and static artifacts.

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
root-relative URL paths; source paths cannot escape the collection root.

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

The default parser accepts YAML frontmatter. Pass `parse` to use another
format. The default compiled representation is `body`; pass `compile` for HTML,
an AST, a search record, or an application-specific object.

## Vite

```ts
import { prachtContent } from "@pracht/content/vite";
import { pracht } from "@pracht/vite-plugin";
import { docs } from "./content";

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), pracht()],
});
```

The first plugin transforms collection sources through the collection's
`module` hook in every Vite environment. The second serves generated artifacts
with GET/HEAD in development and emits identical static files in client builds.
File watcher events invalidate only the affected memoized document.

## Loaders and Markdown negotiation

`contentLoader()` turns route lookup into a Pracht-compatible structural loader
without making `@pracht/core` a dependency. Use `select` to keep loader data
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
import { docs } from "../../../content";

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
backend instead.

See the full framework guide at [docs/CONTENT.md](../../docs/CONTENT.md).
