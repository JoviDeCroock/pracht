# `@pracht/markdown`

`@pracht/markdown` builds Pracht route modules from `@pracht/content`
collections. Relative images written with normal Markdown syntax are imported
through `@pracht/image`, receive intrinsic dimensions and cached responsive
WebP variants, and work in SSR, SSG, and zero-hydration routes.

Install `sharp` as a development dependency when the collection contains local
images; it runs only during development and builds.

## Trust model

**Compiled Markdown is executed as HTML.** The generated route module renders
its markup through `dangerouslySetInnerHTML`, and nothing is sanitized, so raw
HTML embedded in a document — `<script>` tags, `onerror` handlers,
`javascript:` links — runs in the browser exactly as written. This matches how
MDX and other build-time compilers treat source files: a collection is
repo-authored code, reviewed like the rest of the codebase.

Only compile content you trust. If documents come from a CMS, a database, or
anything a user can write, sanitize the HTML before it reaches the page: strip
raw HTML in a custom `parse`, or run the compiled markup through a sanitizer
such as `sanitize-html` or DOMPurify inside the `render` hook.

```ts
import sanitizeHtml from "sanitize-html";

export const posts = defineMarkdownCollection({
  name: "posts",
  root: new URL("./content/posts", import.meta.url),
  render: ({ html }) => sanitizeHtml(html),
});
```

```ts
import { defineMarkdownCollection } from "@pracht/markdown";

export const docs = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/docs", import.meta.url),
  routeBase: "/docs",
});
```

Register the collection and image pipeline before `pracht()`:

```ts
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
import { pracht } from "@pracht/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [prachtContent({ collections: [docs] }), prachtImage(), pracht()],
});
```

Add the route-module types so `import("./guide.md")` typechecks in the app
manifest, either via tsconfig `"types": ["@pracht/markdown/client"]` or a
triple-slash directive in any `.d.ts` file:

```ts
/// <reference types="@pracht/markdown/client" />
```

Each compiled module exports `Component`, a `head()` function, and the exact
original `markdown` source for `Accept: text/markdown` negotiation. Without a
`head()` hook the head defaults to the document's `title` frontmatter, which is
also the field `llmsTxtArtifacts()` indexes by default; an explicit hook wins.

```md
![Generated responsive WebP variants](./assets/hero.jpg)
![Copied from public without processing](/images/hero.jpg)
![Remote image left unchanged](https://images.example.com/hero.jpg)
```

Only relative source images are claimed by the image pipeline. A custom Marked
image renderer supplied through `createMarked` remains authoritative for
root-relative public, remote, and data image URLs.

Use `images: { placeholder: "blur" }` to opt into inline blur styles. The
default is `"empty"`, which avoids changing an application's CSP requirements.
`images.sizes` overrides the browser layout hint; left unset, each image gets
`(max-width: <intrinsic width>px) 100vw, <intrinsic width>px`, so a browser
laying the image out in a narrow prose column requests a matching variant
instead of the widest one. Generated image markers use collection-relative source paths, keeping route
module output stable when the same project is built from a different checkout.
