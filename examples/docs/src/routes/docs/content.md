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

## Resolve content on the server

The package is server-only. Loaders and other deployed server code consume a
filesystem-free snapshot generated from the same registry. Import it by
collection name so Cloudflare, Vercel, and dist-only Node deployments do not
need the source tree at request time.

```ts [src/server/docs-loader.ts]
import { contentLoader } from "@pracht/content";
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
redirect to the canonical locale URL.

## Agent-facing surfaces stay opt-in

`llmsTxtArtifacts()` generates curated `/llms.txt` and `/llms-full.txt` files
from collection metadata and source. It is separate from Pracht's app-graph
`llmsTxt` option: use the framework option for a route/API/capability index, and
the collection helper when titles, descriptions, sections, and full source are
the desired policy. Enabling both at `/llms.txt` fails the build instead of
silently overwriting the collection output. Generated artifacts also cannot
share a path with a file in `public/`; the build rejects the collision before a
later copy can replace generated bytes while retaining their generated headers.
The same preflight rejects prerendered-page overlaps, Pracht's internal
content-header path, and portable case-folded or file/directory collisions.
Custom artifact content types are also applied to non-HTML static assets by the
Node, Cloudflare, Netlify, and Vercel adapters.

`@pracht/content/capabilities` also exports page and basic full-text-search
field factories. Wrap their `input`, `output`, and `run` fields in an app-owned
literal `defineCapability({ ... })` call. That keeps the effect, middleware,
exposure, and `agentPolicy` visible to `pracht verify`; omitting `expose` keeps
the capability private. The page helper returns a missing result for malformed
routes and unsupported locales instead of turning agent input into an execution
failure.

The complete API and extension points live in
[`packages/content/README.md`](https://github.com/JoviDeCroock/pracht/tree/main/packages/content).
