---
title: Content Collections
lead: One server-only registry for content routes, locales, source and compiled documents, and generated static files.
breadcrumb: Content
prev:
  href: /docs/data-loading
  title: Data Loading
next:
  href: /docs/api-routes
  title: API Routes
---

## Install

`@pracht/content` is an opt-in companion package that owns content data. Add
`@pracht/markdown` for Pracht's official Markdown route compiler, and
`@pracht/image` with `sharp` to optimize Markdown images.

```sh
pnpm add @pracht/content @pracht/markdown @pracht/image
pnpm add -D sharp
```

## Define one collection

Define the collection next to the Vite config so every server and build
consumer imports the same registry.

For Markdown, start with `defineMarkdownCollection()`. It keeps the raw Markdown
for content negotiation and compiles relative Markdown images into responsive
markup through `prachtImage()`.

```ts [content.ts]
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  images: { sizes: "(max-width: 960px) 100vw, 960px" },
});
```

Use the lower-level `defineCollection()` when the compiled value is not Markdown
HTML or you need a custom module shape. Sources are discovered recursively from
`root`, or listed explicitly.

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

### Emit the sources themselves

`rawContentArtifacts()` publishes selected documents as static files, so an
agent (or `curl`) can read the Markdown behind a page instead of scraping HTML:

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

Like every artifact, it is served live in development and emitted to
`dist/client/` at build time.

### Parsing frontmatter yourself

`compile()` already receives `body` and `frontmatter`. For code outside a
collection, such as a script, a test, or a custom loader, use
`parseFrontmatter()`:

```ts
import { parseFrontmatter } from "@pracht/content";

const { frontmatter, body } = parseFrontmatter<{ title: string }>(raw);
```

It throws a `TypeError` when the frontmatter is not a YAML mapping, and returns
`{ frontmatter: {}, body: raw }` when there is none.

## Add the Vite integration

Place `prachtContent()` and `prachtImage()` before `pracht()`:

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

The package is server-only. Loaders import a filesystem-free snapshot by
collection name, so deployments do not need the source tree at request time.

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
`@pracht/content/virtual` to `compilerOptions.types` for the virtual module's
types; augment it when you want exact compiled and frontmatter types.

Lookups fall back to the default locale unless you pass `fallback: false`.
`resolveById()` and `resolveByRoute()` also report whether the result is a
fallback, so you can show that or redirect to the canonical locale URL.
Fallback targets must be listed in `supported`.

With `routePrefix: "never"`, translations share one route; pass `locale` during
lookup to pick one.

## Agent-facing surfaces stay opt-in

A collection publishes nothing on its own. Raw sources, `llms.txt`, and
capabilities each need an explicit opt-in.

`llmsTxtArtifacts()` generates curated `/llms.txt` and `/llms-full.txt` from
collection titles, descriptions, sections, and source. Pracht's app-graph
`llmsTxt` option is different: it indexes routes, API routes, and capabilities.
Enabling both at `/llms.txt` fails the build; set a different `summaryPath` or
pick one.

The build also fails when an artifact path collides with a file in `public/`, a
prerendered page, or a request-time page or API route. The error names the
collision.

The Node, Cloudflare, Netlify, and Vercel adapters serve artifacts with the
`contentType` you set.

`@pracht/content/capabilities` exports `createContentPageCapability()` and
`createContentSearchCapability()`. They return `input`, `output`, and `run`
fields for a capability you define:

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

Keep the `defineCapability({ ... })` call literal so `pracht verify` can audit
its effect, middleware, exposure, and `agentPolicy`. Without `expose`, the
capability stays private.

The complete API and extension points live in
[`packages/content/README.md`](https://github.com/JoviDeCroock/pracht/tree/main/packages/content).
