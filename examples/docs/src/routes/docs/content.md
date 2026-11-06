---
title: Content collections
lead: Register Markdown and other content once to get routes, locales, compiled documents, and generated files such as `llms.txt`.
---

## Install

Add `@pracht/content` for collections and `@pracht/markdown` for the Markdown compiler. Add `@pracht/image` and `sharp` to optimize images referenced from Markdown:

```sh
pnpm add @pracht/content @pracht/markdown @pracht/image
pnpm add -D sharp
```

## Define a Markdown collection

Define the collection in a file next to `vite.config.ts`, so the Vite plugin and your server code import the same registry:

```ts [content.ts]
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  images: { sizes: "(max-width: 960px) 100vw, 960px" },
});
```

Every `.md` and `.markdown` file under `root` becomes a document. `src/routes/docs/intro.md` gets the route `/docs/intro`, and an `index.md` gets `/docs`. Relative images in the Markdown compile to responsive `<img>` markup through `prachtImage()`.

Each Markdown file imported as a route module exports a `Component` that renders the HTML, a `head()` that sets the page title from the `title` frontmatter field, and the raw source as `markdown` for [content negotiation](/docs/agents#a-md-url-for-static-markdown-pages).

| Option | Default | Purpose |
| ------ | ------- | ------- |
| `name` | required | Collection name, used in `virtual:pracht/content/<name>` |
| `root` | required | Absolute path or file URL holding the sources |
| `routeBase` | `/` | Prefix for generated routes |
| `route(context)` | | Return a custom route, or `false` to leave a source out |
| `sources` | scan `root` | Explicit list of `{ source, id?, path?, locale? }` |
| `extensions` | `.md`, `.markdown` | File extensions to scan |
| `locales` | | See [Locales](#locales) |
| `parse(raw, source)` | YAML frontmatter | Custom frontmatter parser |
| `createMarked()` | | Return a configured `Marked` instance per document |
| `render({ html, input })` | | Post-process the compiled HTML |
| `head({ html, input })` | `{ title }` | Return the route's `head()` metadata |
| `images` | | `{ sizes, placeholder: "blur" \| "empty" }` for Markdown images |
| `artifacts` | `[]` | Generated files, such as `llmsTxtArtifacts()` |
| `snapshot` | `{ raw: true, body: true }` | Set a field to `false` to drop it from the server bundle |

> [!WARNING]
> Compiled Markdown is inserted as raw HTML, so `<script>` tags and event handlers in a document run. Sanitize content from a CMS or from users in `parse` or `render`.

## Register the routes

A collection does not add routes on its own. Register each Markdown file in the manifest:

```ts [src/routes.ts]
import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [
    route("/docs/intro", "./routes/docs/intro.md", { render: "ssg" }),
  ],
});
```

The [pages router](/docs/routing#pages-router-auto-discovery) discovers `.md` files without a manifest.

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

`pracht build` warns when a document's route is served by no app route, because `llms.txt` and raw-source files would link to a 404:

```text
1 content document generates a route no app route serves:
    /docs/draft (collection "docs", draft.md)
```

Set `unroutedDocuments` to change that check:

| `unroutedDocuments` | Effect |
| ------------------- | ------ |
| `"warn"` (default) | Print the warning and finish the build |
| `"error"` | Fail the build |
| `"ignore"` | Skip the check, for a data-only collection whose documents are never pages |

```ts [vite.config.ts]
prachtContent({ collections: [docs], unroutedDocuments: "error" });
```

## Use a custom compiler

Use `defineCollection()` from `@pracht/content` when the compiled value is not Markdown HTML, or you need a custom route module. It takes the same `name`, `root`, `sources`, `routeBase`, `route`, `locales`, `parse`, `artifacts`, and `snapshot` options, scans `.md` and `.mdx` by default, and adds:

| Option | Purpose |
| ------ | ------- |
| `compile(input)` | Turn a parsed document into any value, stored as `compiled` |
| `module(document)` | Return the source of the Vite route module for a document |

```ts [content.ts]
import { defineCollection } from "@pracht/content";

import { renderMarkdown } from "./src/server/render-markdown.ts";

export const notes = defineCollection({
  name: "notes",
  root: new URL("./src/routes/notes", import.meta.url),
  routeBase: "/notes",
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
});
```

Every document has the same shape:

| Field | Value |
| ----- | ----- |
| `id`, `path`, `locale` | Locale-neutral id, public route, and locale |
| `source`, `relativeSource` | Absolute and root-relative file path |
| `raw` | The exact source |
| `body` | The source without YAML frontmatter |
| `frontmatter` | The parsed YAML mapping |
| `compiled` | What `compile()` returned |

## Read content on the server

Import a collection's snapshot by name from `virtual:pracht/content/<name>`. The snapshot holds no file paths, so the deployment does not need the source tree:

```ts [src/routes/notes-page.tsx]
import { contentLoader } from "@pracht/content/runtime";
import notes from "virtual:pracht/content/notes";

export const loader = contentLoader(notes, {
  select(document) {
    return {
      html: document.compiled as string,
      title: document.frontmatter.title as string,
    };
  },
});
```

`contentLoader()` looks the document up by the matched route path and throws a `404` when none exists. Pass `path(args)`, `locale(args)`, or `notFound(path)` to change that. For lookups in your own code, a snapshot has `all()`, `getById()`, `getByRoute()`, `resolveById()`, and `resolveByRoute()`.

Snapshot frontmatter and compiled values must be JSON-serializable. Add `@pracht/content/virtual` to `compilerOptions.types` to type the virtual module.

### Locales

```ts [content.ts]
locales: {
  default: "en",
  supported: ["en", "fr"],
},
```

With `locales`, a top-level directory named after a locale sets the document's locale: `fr/intro.md` is the French `intro`. Routes for non-default locales get a prefix, `/fr/docs/intro`; set `routePrefix` to `"always"` or `"never"` to change that.

Lookups fall back to the default locale unless you pass `fallback: false`. `resolveById()` and `resolveByRoute()` also report whether the result is a fallback, so you can show a notice or redirect to the canonical URL. Set `fallback` in `locales` to choose another order; every target must be in `supported`. With `routePrefix: "never"`, translations share one route, and you pass `locale` to the lookup.

## Publish raw sources

`rawContentArtifacts()` publishes documents as static files, so an agent or `curl` can read the Markdown behind a page:

```ts [content.ts]
import { rawContentArtifacts } from "@pracht/content";
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  artifacts: [
    rawContentArtifacts({
      // Return the artifact path, or false to skip the document.
      path: (document) => `${document.path}.txt`,
      // "raw" (default) keeps the frontmatter; "body" strips it.
      representation: "body",
      contentType: "text/plain; charset=utf-8",
    }),
  ],
});
```

Artifacts are served live by `pracht dev` and written to `dist/client/` by `pracht build`. SSG pages with a `markdown` export already get a [`<path>.md` file](/docs/agents#a-md-url-for-static-markdown-pages), so use this for a different path or representation.

Without `contentType`, an artifact gets the type a static file with the same extension gets. The build fails when an artifact path collides with a file in `public/`, a prerendered page, or a request-time page or API route; the error names the collision.

## Generate llms.txt from a collection

A collection publishes nothing for agents until you add an artifact. `llmsTxtArtifacts()` writes a curated `/llms.txt` from document titles and descriptions, plus `/llms-full.txt` with every listed page inlined. [Agents](/docs/agents) explains how agents use these files.

```ts [content.ts]
import { llmsTxtArtifacts } from "@pracht/content";

llmsTxtArtifacts({
  title: "My docs",
  description: "Guides and API reference for My product.",
  origin: "https://example.com",
  // Link each entry to the page's Markdown instead of its HTML.
  link: (document) => `${document.path}.md`,
  sections: [
    { heading: "Guides", match: "/docs/guides", fullPath: "/llms-guides.txt" },
    { heading: "API", match: "/docs/api", fullPath: "/llms-api.txt" },
  ],
});
```

| Option | Default | Purpose |
| ------ | ------- | ------- |
| `title` | required | `#` heading of `/llms.txt` |
| `description`, `details` | | Blockquote summary and extra Markdown lines under the title |
| `origin` | | Absolute site origin prefixed to every link |
| `link(document)` | `document.path` | Root-relative URL each entry links to |
| `sections` | one `Pages` section | `{ heading, match, fullPath?, optional?, sort? }` groups |
| `summaryPath` | `/llms.txt` | Path of the index |
| `fullPath` | `/llms-full.txt` | Path of the full-text file, or `false` to skip it |
| `titleField`, `descriptionField` | `title`, `lead` | Frontmatter fields read for each entry |

Each section becomes a `##` list of the pages it matches, by route prefix or a predicate, in collection order unless it passes `sort`. A section with `fullPath` also gets a file holding only its pages. Those files and `/llms-full.txt` are listed under a final `## Optional` heading with their page and word counts. A section that matches nothing produces no heading and no file.

With `origin` set, each page in a full-text file starts with its title and a `Source:` line holding its URL, so an agent can cite it. Point `link` only at URLs the site serves.

The Vite plugin's app-graph `llmsTxt` option also writes `/llms.txt`. Enabling both at that path fails the build; set a different `summaryPath` or use one.

## Expose content as capabilities

`createContentPageCapability()` and `createContentSearchCapability()` from `@pracht/content/capabilities` return the `input`, `output`, and `run` fields of a [capability](/docs/capabilities):

```ts [src/capabilities/docs-read.ts]
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
});
```

Keep the `defineCapability({ ... })` call literal so `pracht verify` can audit its effect, middleware, exposure, and `agentPolicy`. Without `expose`, the capability stays private.

## Parse frontmatter yourself

`compile()` already receives `body` and `frontmatter`. In a script, a test, or a custom loader, call `parseFrontmatter()`:

```ts
import { parseFrontmatter } from "@pracht/content";

const { frontmatter, body } = parseFrontmatter<{ title: string }>(raw);
```

It returns `{ frontmatter: {}, body: raw }` when there is no frontmatter, and throws a `TypeError` when the frontmatter is not a YAML mapping.

The [`@pracht/content` README](https://github.com/JoviDeCroock/pracht/tree/main/packages/content) lists the full API.
