---
title: Styling
lead: Style routes with CSS Modules, Tailwind, or plain stylesheets, which pracht loads at build time. Avoid runtime CSS-in-JS on server-rendered routes.
---

## Recommended approaches

Import CSS from a route, shell, or island. pracht links the stylesheets each page needs in its initial HTML. Any approach that produces real CSS files Vite tracks works:

- **CSS Modules**: co-located, scoped per file.
- **Tailwind CSS** via `@tailwindcss/vite`: one generated stylesheet.
- **Plain `.css` / `.scss` imports**: global, or scoped by convention.
- **PostCSS** pipelines (Open Props, Pico): anything emitted as a static stylesheet.

```tsx [src/routes/home.tsx]
import "../styles/global.css";
import styles from "./home.module.css";

export default function Home() {
  return <h1 class={styles.title}>Hello</h1>;
}
```

## How route CSS is loaded

Each page links the CSS imported by its route, its shell, and the islands it rendered, including their transitive imports. [Performance](/docs/performance#css-per-page) shows how routes map to stylesheets.

- Every hydration mode gets its CSS. A `hydration: "none"` or `"islands"` route also gets the images, fonts, and `@import`ed stylesheets that CSS references, and assets it imports directly, such as `import dots from "./dots.svg"` or a `?pracht` image.
- An asset that only an API route or a loader reads stays server-side.
- Deferred islands (`client="visible"`, `client="idle"`) still have their CSS in the document, so their markup never paints unstyled.
- `pracht dev` links the same CSS in the initial HTML. You do not need a development-only `<link>` in `head()`.

Run `pracht inspect build` after a build to see which stylesheets each route links.

`build.cssCodeSplit: false` fails the build with `[pracht] build.cssCodeSplit is disabled.`, because one merged stylesheet would leave every page unstyled. Use `inlineCss` to remove the stylesheet request instead.

## Inline small stylesheets

Production links route-scoped stylesheets by default. Set `inlineCss` to put the matched route and shell CSS in the document instead:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ inlineCss: true })],
});
```

This removes a render-blocking request but repeats shared CSS in every HTML response, so [measure the trade-off](/docs/performance#css-per-page). It tends to win on static or content sites that visitors enter cold from search.

## CSS Modules

Name the file `*.module.css`, import it, and reference classes from the resulting object:

```css [src/routes/home.module.css]
.hero {
  padding: 4rem 2rem;
  text-align: center;
}

.title {
  font-size: 2.5rem;
  font-weight: 700;
}
```

```tsx [src/routes/home.tsx]
import styles from "./home.module.css";

export default function Home() {
  return (
    <section class={styles.hero}>
      <h1 class={styles.title}>Welcome</h1>
    </section>
  );
}
```

Vite generates unique class names at build time (for example `_hero_1a2b3`), so styles never collide across routes.

## Tailwind CSS

Install Tailwind's Vite plugin and add it next to the pracht plugin:

```sh
pnpm add -D @tailwindcss/vite tailwindcss
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [pracht(), tailwindcss()],
});
```

Import Tailwind from a stylesheet, and import that stylesheet from your shell:

```css [src/styles/global.css]
@import "tailwindcss";
```

Tailwind classes work on every route in every render mode, because the generated stylesheet is a static asset linked in the HTML.

## Runtime CSS-in-JS

Runtime CSS-in-JS libraries such as styled-components, Emotion, and goober run in a pracht app, but pracht does not collect their generated styles into server-rendered HTML:

| Render mode | Result |
| ----------- | ------ |
| `spa` | Works: styles are injected on the client after mount |
| `ssr` / `ssg` / `isg` | The page paints unstyled, then repaints when client JavaScript injects the styles |

That flash of unstyled content hurts Core Web Vitals. Use CSS Modules, Tailwind, or plain CSS on any route that renders on the server, and keep CSS-in-JS to `spa` routes.
