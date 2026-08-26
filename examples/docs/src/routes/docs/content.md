---
title: Content Collections
lead: Use one server-only registry for route/source mapping, locales, source and compiled representations, build iteration, and generated static assets.
breadcrumb: Content
prev:
  href: /docs/data-loading
  title: Data Loading
next:
  href: /docs/api-routes
  title: API Routes
---

## Install

`@pracht/content` is an opt-in companion package. It owns content data; it does
not choose your route structure or public agent surface. Add
`@pracht/markdown` when you want Pracht's official Markdown route compiler.

```sh
pnpm add @pracht/content @pracht/markdown @pracht/image
pnpm add -D sharp
```

## Define one collection

For Markdown documentation, start with `defineMarkdownCollection()`. It wraps
the lower-level collection primitive, preserves raw Markdown for content
negotiation, and compiles normal relative Markdown images into intrinsic,
responsive markup through `prachtImage()`.

```ts [content.ts]
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  images: { sizes: "(max-width: 960px) 100vw, 960px" },
});
```

Use the lower-level `defineCollection()` API when the compiled representation
is not Markdown HTML or when the application needs a completely custom module
shape:

Define the collection next to the Vite config so every server/build consumer
imports the same registry. Sources can be listed explicitly, or discovered
recursively from `root`.

The root can be a symbolic link; Vite's canonical module IDs still map back to
the collection registry. Symbolic links inside it cannot escape the root.

```ts [content.ts]
import { defineCollection, llmsTxtArtifacts } from "@pracht/content";

export const docs = defineCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  locales: {
    default: "en",
    supported: ["en", "fr"],
  },
  compile({ body }) {
    return renderMarkdown(body);
  },
  module(document) {
    return `
      import { h } from "preact";
      export const markdown = ${JSON.stringify(document.raw)};
      export function Component() {
        return h("article", { dangerouslySetInnerHTML: { __html: ${JSON.stringify(document.compiled)} } });
      }
    `;
  },
  artifacts: [
    llmsTxtArtifacts({
      title: "My docs",
      sections: [{ heading: "Docs", match: "/docs" }],
    }),
  ],
});
```

Every document has one stable shape:

- `id`, `path`, `locale`, `source`, and `relativeSource` identify it;
- `raw` preserves the exact source, while `body` removes YAML frontmatter;
- `frontmatter` is the parsed YAML mapping;
- `compiled` is whatever your compiler returns.

The compiler is memoized per source. Filesystem reads reuse the compiled value
until the file's mtime or size changes; Vite transforms invalidate the matching
entry on add, change, or unlink.

### Emit the sources themselves

`rawContentArtifacts()` publishes selected documents as ordinary static assets —
useful for serving the Markdown behind a page so an agent (or a `curl`) can read
the source instead of scraping the rendered HTML:

```ts [content.ts]
import { defineCollection, rawContentArtifacts } from "@pracht/content";

artifacts: [
  rawContentArtifacts({
    // Return the artifact path, or `false` to skip the document.
    path: (document) => `${document.path}.md`,
    // "raw" (default) emits the full source; "body" strips YAML frontmatter.
    representation: "body",
    contentType: "text/markdown; charset=utf-8",
  }),
];
```

Like `llmsTxtArtifacts()`, the generator runs in development against the live
files and is emitted to `dist/client/` at build time.

### Parsing frontmatter yourself

`compile()` already receives `body` with frontmatter removed and `frontmatter`
parsed. `parseFrontmatter()` is the same parser exported on its own, for code
outside a collection — a script, a test, a custom loader:

```ts
import { parseFrontmatter } from "@pracht/content";

const { frontmatter, body } = parseFrontmatter<{ title: string }>(raw);
```

It throws a `TypeError` when the frontmatter block is not a YAML mapping, and
returns `{ frontmatter: {}, body: raw }` when there is no block at all.

## Add the Vite integration

Place `prachtContent()` and `prachtImage()` before `pracht()`. They transform
registered source modules in both client and server graphs, serve generated
artifacts and image variants live in development, and emit the same files for
production.

```ts [vite.config.ts]
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";
import { docs } from "./content";

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), prachtImage(), pracht()],
});
```

## Markdown pages ship their prose once

A compiled document becomes a route module whose exports are all server-only
except the component:

```js
export const markdown = "…raw source…"; // Accept: text/markdown, llms.txt
export function head() { … }             // frontmatter title by default
export function loader() {
  return { html: serverOnly(compiledHtml) };
}
export function Component({ data }) {
  return <StaticHtml class="pracht-markdown" html={data.html} />;
}
```

`loader` is stripped from client builds, and it takes the compiled page with
it. `<StaticHtml>` adopts the markup the server already wrote into the document
instead of hydrating it, so a Markdown page's route chunk is a couple of
hundred bytes rather than a second copy of the article. Client-side navigation
is unaffected — the markup arrives in the route-state response Pracht already
fetches for `head()`. See
[server-only values](/docs/data-loading) for the underlying primitives.

Two things follow from this:

- `useRouteData()` on a Markdown route returns `{ html }`, where `html` is a
  `ServerOnly<string>`. Read it with `readServerOnly()` or render it through
  `<StaticHtml>`.
- Nothing inside the rendered Markdown is interactive — that subtree never
  hydrates. Put interactive pieces in the shell, or on an
  [islands](/docs/islands) route.

## Resolve content on the server

The package is server-only. Loaders and other deployed server code consume a
filesystem-free snapshot generated from the same registry. Import it by
collection name so Cloudflare, Vercel, and dist-only Node deployments do not
need the source tree at request time.

```ts [src/server/docs-loader.ts]
import { contentLoader } from "@pracht/content/runtime";
import docs from "virtual:pracht/content/docs";

export const loader = contentLoader(docs, {
  select(document) {
    return {
      html: document.compiled,
      title: document.frontmatter.title,
    };
  },
});
```

Snapshot frontmatter and compiled values must be JSON-serializable. Add
`@pracht/content/virtual` to `compilerOptions.types` for the generic virtual
module declaration; applications can augment it when they want exact compiled
and frontmatter types.

Locale lookup falls back to the default locale unless `fallback: false` is
requested. `resolveById()` and `resolveByRoute()` additionally report whether
the returned document is a fallback, so applications can make that visible or
redirect to the canonical locale URL. Every configured fallback target must be
included in `supported`; invalid fallback configuration is rejected when the
collection is defined. `routePrefix: "never"` deliberately shares one route
between translations; pass `locale` during lookup to select one.

## Agent-facing surfaces stay opt-in

`llmsTxtArtifacts()` generates curated `/llms.txt` and `/llms-full.txt` files
from collection metadata and source. It is separate from Pracht's app-graph
`llmsTxt` option: use the framework option for a route/API/capability index, and
the collection helper when titles, descriptions, sections, and full source are
the desired policy. Enabling both at `/llms.txt` fails the build instead of
silently overwriting the collection output. Generated artifacts also cannot
share a path with a file in `public/`; the build rejects the collision before a
later copy can replace generated bytes while retaining their generated headers.
The same preflight rejects prerendered-page overlaps, exact request-time page
or API paths, clean-URL `index.html` aliases, concrete ISG paths served by an
adapter function, Pracht's internal content-header path, and portable
case-folded or file/directory collisions, including Netlify control-file paths.
Custom artifact content types are also applied to non-HTML static assets by the
Node, Cloudflare, Netlify, and Vercel adapters. Artifacts inside an `/assets/`
path use revalidation caching because their filenames are not required to
contain a content hash.

`@pracht/content/capabilities` also exports page and basic full-text-search
field factories. Wrap their `input`, `output`, and `run` fields in an app-owned
literal `defineCapability({ ... })` call. That keeps the effect, middleware,
exposure, and `agentPolicy` visible to `pracht verify`; omitting `expose` keeps
the capability private. The page helper returns a missing result for malformed
routes and unsupported locales instead of turning agent input into an execution
failure. Both helpers advertise supported locales for localized collections,
while the search helper leaves unlocalized results intact when a locale hint is
supplied.

The complete API and extension points live in
[`packages/content/README.md`](https://github.com/JoviDeCroock/pracht/tree/main/packages/content).
