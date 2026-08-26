---
name: add-content
version: 1.0.1
description: |
  Wire `@pracht/content` and `@pracht/markdown`: a collection registry owning
  source discovery, routes, locales, compilation, and static artifacts
  (`llms.txt`, raw source), plus Markdown/MDX route modules and snapshot loaders.
  Use for "add a blog", "set up docs", "render markdown pages", "add MDX",
  "content collections", "why is my markdown route 404ing".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Content Collections

`@pracht/content` is the optional, **server-only** content layer
(`docs/CONTENT.md`). It exists so a content-heavy app has *one* registry
instead of two readers that drift — route modules reading source through Vite,
and sitemap/`llms.txt`/search plugins scanning the filesystem again.
`@pracht/markdown` is the opinionated Markdown route-module compiler on top of
it (`packages/markdown/README.md`).

Nothing here is on by default: adding a collection publishes no source and
creates no agent surface until you add artifacts or capabilities.

## Step 1: Pick the shape

Ask with `AskUserQuestion` when it is not obvious from the repo:

| Situation | Wiring |
| --------- | ------ |
| Markdown/MDX files that should *be* pages | `@pracht/markdown` → `defineMarkdownCollection()` |
| Content that feeds loaders, search, or an API — never a page | `@pracht/content` → `defineCollection()` with `unroutedDocuments: "ignore"` |
| An app-specific compiler (custom AST, page model, search record) | `defineCollection({ compile, module })` |

Also settle: collection root directory, `routeBase`, whether documents are
localized, and whether relative images appear in the Markdown.

## Step 2: Install

```bash
pnpm add @pracht/content
pnpm add @pracht/markdown @pracht/image   # Markdown route modules
pnpm add -D sharp                          # only when documents embed local images
```

`sharp` runs at build/dev time only and never ships to a runtime bundle.

## Step 3: Define the collection outside the vite config

Put the collection in its own module (`content.ts`) so the vite config, build
plugins, and tests import the same object:

```ts
// content.ts
import { llmsTxtArtifacts, rawContentArtifacts } from "@pracht/content";
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  // locales: { default: "en", supported: ["en", "fr"] },
  // images: { placeholder: "blur" },      // default "empty" — keeps CSP unchanged
  // snapshot: { raw: false },             // drop a representation you never read
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

Without `sources`, the registry scans `root` recursively for `.md`/`.mdx`;
`index` files collapse to their directory. Pass explicit
`{ id, path, source, locale }` entries when routes must not be inferred.
Duplicate ids, routes, sources, or artifact paths throw at definition time
rather than letting file order pick a winner.

## Step 4: Register the plugins (order matters)

```ts
// vite.config.ts
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";
import { docs } from "./content";

export default defineConfig({
  plugins: [
    prachtContent({ collections: [docs] }), // one call, every collection
    prachtImage(),                          // relative Markdown images
    pracht(),
  ],
});
```

Register **all** collections through a single `prachtContent()` call — the
plugin owns one internal build manifest and rejects a second registration.

## Step 5: Point routes at the documents

Markdown modules are ordinary route modules (they export `Component`, `head()`,
and the raw `markdown` string for `Accept: text/markdown` negotiation):

```ts
route("/docs/routing", () => import("./routes/docs/routing.md"), {
  id: "routing",
  render: "ssg",
});
```

Sources and routes are still two readers, so `pracht build` reconciles them and
names every document (and generated locale alias) that no route serves — a
document without a route still reaches `llms.txt` and `rawContentArtifacts()`
while the page answers 404. The default policy is `"warn"`:

```ts
prachtContent({ collections: [docs], unroutedDocuments: "error" });
```

Use `"error"` for a docs site, `"ignore"` for a data-only collection. On a
static export a dynamic SSG route only covers the concrete paths
`getStaticPaths()` returns, and a dynamic SPA route only covers deep links when
`staticAdapter({ fallback })` emits one. `pracht verify` cannot do this check —
it reads the vite config as text — so run a build before believing the routing
is complete.

## Step 6: Read the collection at request time

Loaders, middleware, API routes, and capabilities must import the **generated
snapshot**, not the filesystem-backed authoring object:

```ts
import { contentLoader } from "@pracht/content/runtime";
import docs from "virtual:pracht/content/docs";

export const loader = contentLoader(docs, {
  select: (document) => ({ html: document.compiled, title: document.frontmatter.title }),
});
```

- The virtual module is **server-only**; a retained client import fails the
  build instead of shipping source, frontmatter, and compiled values to the
  browser.
- Every accessor is async: each document's `raw`/`body`/`compiled` lives in its
  own deferred chunk, so the first content-backed request does not parse the
  whole collection. `iterate()` streams one document at a time; `all()` loads
  everything.
- `contentLoader()` uses the matched, base-free `pathname`, and answers
  unmatchable pathnames (`/docs/%2e%2e`) with its not-found path instead of
  failing the request.
- `markdownRepresentation(document, "raw" | "body")` produces the server-only
  `markdown` export for content negotiation — it throws when `snapshot` dropped
  the field you selected.
- Frontmatter and compiled values must be JSON-serializable; the build names
  the offending value path otherwise.

Add types once: `"types": ["@pracht/markdown/client", "@pracht/content/virtual"]`
in tsconfig (or triple-slash references in any `.d.ts`).

## Step 7: Artifacts and the two llms.txt files

`llmsTxtArtifacts()` (collection-driven, curated, can emit an `llms-full.txt`)
is **not** the same as the core `llmsTxt` plugin option (app-graph driven,
`docs/LLMS_TXT.md`). Both default to `/llms.txt`, and enabling both fails the
build rather than silently overwriting — pick one, or give the collection a
distinct `summaryPath`. A third, unrelated file is `pracht llms`, which prints
the *authoring guide* for coding agents; `pracht llms --write` drops it in the
app root, which is exactly the confusing filename collision to avoid in an app
that publishes its own index.

Localization trap: a string `section.match` is compared against the
**locale-neutral** route, so `match: "/docs"` indexes only the default locale
while `rawContentArtifacts()` publishes every translation. Pass a `match`
function to index one locale deliberately.

Artifact paths are preflighted: canonical ASCII segments only, no overlap with
`publicDir`, bundle output, prerendered pages, request-time page/API paths,
concrete ISG paths, the `/_pracht` namespace, or Netlify's `/_headers` and
`/_redirects`.

## Step 8: Deployment notes

- **Cloudflare** — deferred content chunks require `"no_bundle": true` and an
  `ESModule` rule covering `"**/*.js"` in `wrangler.jsonc`; `pracht verify`
  warns when either is missing. New `create-pracht` projects have both.
- **Content type headers** — explicit artifact `contentType` values flow into
  the production headers manifest and are applied by the Node, Cloudflare,
  Netlify, and Vercel adapters.
- **Bundle cost** — payload chunks carry roughly two to three times the source
  bytes. `snapshot: { raw: false }` or `{ body: false }` drops a representation
  the app never reads; `compiled` and frontmatter cannot be dropped.

## Step 9: Optional agent surface

`@pracht/content/capabilities` exports `createContentPageCapability()` and
`createContentSearchCapability()`, which return `input`/`output`/`run` fields.
Keep the literal `defineCapability({ ... })` in the app so `pracht verify` can
audit exposure and policy statically — see `/add-capabilities`. Both helpers
read `document.body` and refuse a body-free snapshot when constructed.

## Step 10: Verify

```bash
pracht build          # reconciliation warnings + artifact preflight
pracht verify --json
pracht typegen        # after route ids or paths change
```

Then load a content route in `pracht dev`, edit a source file, and confirm the
watcher invalidates it (collection roots outside Vite's project root are added
to the watcher explicitly).

## Rules

1. **Compiled Markdown is executed as HTML, unsanitized.** The generated route
   module renders through `dangerouslySetInnerHTML`. Only compile
   repo-authored, reviewed content; sanitize in `parse` or `render` (e.g.
   `sanitize-html`) before compiling anything from a CMS, a database, or a
   user.
2. Never import a capability-facing or loader-facing collection from client
   code — import `virtual:pracht/content/<name>` inside server code only.
3. One `prachtContent()` call, with every collection in it.
4. Do not enable the core `llmsTxt` option and a collection `/llms.txt`
   artifact at the same time.
5. Adding a collection must not publish raw source implicitly — add
   `rawContentArtifacts()` only when publishing sources is intended.
6. Never overwrite an existing `vite.config.ts`, `wrangler.jsonc`, or content
   module — diff first and confirm collisions with `AskUserQuestion`.

$ARGUMENTS
