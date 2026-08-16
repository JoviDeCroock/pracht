# `@pracht/markdown`

`@pracht/markdown` builds Pracht route modules from `@pracht/content`
collections. Relative images written with normal Markdown syntax are imported
through `@pracht/image`, receive intrinsic dimensions and cached responsive
WebP variants, and work in SSR, SSG, and zero-hydration routes.

Install `sharp` as a development dependency when the collection contains local
images; it runs only during development and builds.

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

```md
![Generated responsive WebP variants](./assets/hero.jpg)
![Copied from public without processing](/images/hero.jpg)
![Remote image left unchanged](https://images.example.com/hero.jpg)
```

Use `images: { placeholder: "blur" }` to opt into inline blur styles. The
default is `"empty"`, which avoids changing an application's CSP requirements.
