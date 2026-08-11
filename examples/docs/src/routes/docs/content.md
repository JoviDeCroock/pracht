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
not choose your renderer, route structure, or public agent surface.

```sh
pnpm add @pracht/content
```

## Define one collection

Define the collection next to the Vite config so every server/build consumer
imports the same registry. Sources can be listed explicitly, or discovered
recursively from `root`.

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

Place `prachtContent()` before `pracht()`. It transforms registered source
modules in both client and server graphs, serves generated artifacts live in
development, and emits the same files in the client build.

```ts [vite.config.ts]
import { prachtContent } from "@pracht/content/vite";
import { pracht } from "@pracht/vite-plugin";
import { docs } from "./content";

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), pracht()],
});
```

## Resolve content on the server

The package is server-only. Loaders and other server code can resolve by public
route, locale-neutral id, or source file, and build plugins can iterate the
same registry without maintaining a second filesystem scanner.

```ts [src/server/docs-loader.ts]
import { contentLoader } from "@pracht/content";
import { docs } from "../../content";

export const loader = contentLoader(docs, {
  select(document) {
    return {
      html: document.compiled,
      title: document.frontmatter.title,
    };
  },
});
```

Locale lookup falls back to the default locale unless `fallback: false` is
requested. `resolveById()` and `resolveByRoute()` additionally report whether
the returned document is a fallback, so applications can make that visible or
redirect to the canonical locale URL.

## Agent-facing surfaces stay opt-in

`llmsTxtArtifacts()` generates curated `/llms.txt` and `/llms-full.txt` files
from collection metadata and source. It is separate from Pracht's app-graph
`llmsTxt` option: use the framework option for a route/API/capability index, and
the collection helper when titles, descriptions, sections, and full source are
the desired policy.

`@pracht/content/capabilities` also exports page and basic full-text-search
field factories. Wrap their `input`, `output`, and `run` fields in an app-owned
literal `defineCapability({ ... })` call. That keeps the effect, middleware,
exposure, and `agentPolicy` visible to `pracht verify`; omitting `expose` keeps
the capability private.

The complete API and extension points live in
[`packages/content/README.md`](https://github.com/JoviDeCroock/pracht/tree/main/packages/content).
