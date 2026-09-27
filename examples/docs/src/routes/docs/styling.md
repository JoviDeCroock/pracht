---
title: Styling
lead: Pracht optimizes style loading for CSS that exists at build time. Prefer CSS Modules, Tailwind, or plain stylesheets over runtime CSS-in-JS — especially on server-rendered routes.
breadcrumb: Styling
prev:
  href: /docs/shells
  title: Shells
next:
  href: /docs/fonts
  title: Fonts
---

## Recommended Approaches

These all produce real CSS files that Vite tracks. Pracht uses that module graph to link only the stylesheets a route needs, in the initial HTML.

- **CSS Modules** — co-located, automatically scoped per file
- **Tailwind CSS** via `@tailwindcss/vite` — utility-first, single generated stylesheet
- **Plain `.css` / `.scss` imports** — global or module-scoped by convention
- **PostCSS** pipelines (Open Props, Pico, etc.) — anything emitted as a static stylesheet

```tsx [src/routes/home.tsx]
import styles from "./home.module.css";

export default function Home() {
  return <h1 class={styles.title}>Hello</h1>;
}
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [pracht(), tailwindcss()],
});
```

See [Performance → CSS Per Page](/docs/performance) for how pracht maps routes to their transitive CSS dependencies.

Route CSS works the same in every hydration mode. A `hydration: "none"` or `"islands"` route still gets the CSS it imports, plus the images, fonts, and `@import`ed stylesheets that CSS references.

Assets those routes import directly are published too, like `import dots from "./dots.svg"` or a `?pracht` image. An asset that only an API route or a loader reads stays server-side.

Each page also links the CSS of the islands it rendered, including deferred islands (`client="visible"`, `client="idle"`), so island markup does not paint unstyled first.

`pracht build` writes the route-to-stylesheet mapping to `dist/server/css-manifest.json`, which `pracht inspect build` reads. Nothing reads it at runtime.

`pracht dev` links the same CSS in the initial HTML. Import CSS from a route or shell; you do not need a development-only `<link>` in `head()`.

Production links route-scoped stylesheets by default. For small stylesheets,
`pracht({ inlineCss: true })` puts the matched route and shell CSS in the
document instead. That removes a render-blocking request but repeats shared CSS
in every HTML response, so [measure the trade-off](/docs/performance#css-per-page).
It tends to win on static or content sites that visitors enter cold from search.

`build.cssCodeSplit: false` is not supported: it merges all CSS into one file
that pracht's per-route documents never link, so the build refuses it.

---

## CSS-in-JS — Use With Care

Runtime CSS-in-JS libraries like **styled-components**, **Emotion**, and **goober** work in a pracht app, but pracht cannot collect their runtime-generated styles into the server-rendered HTML.

| Route mode        | CSS-in-JS support                                                 |
| ----------------- | ----------------------------------------------------------------- |
| `spa` (CSR only)  | ✅ Works — styles are injected on the client after mount           |
| `ssr` / `ssg` / `isg` | ⚠️ Flash of unstyled content until hydration catches up       |

On server-rendered routes:

1. The server renders HTML without the matching `<style>` tags.
2. The browser paints the unstyled HTML.
3. Client JavaScript runs and injects the styles.
4. The browser repaints: a visible flash of unstyled content that hurts Core Web Vitals.

**Guidance:** use a build-time approach (CSS Modules, Tailwind, plain CSS) for any route that runs on the server. Keep CSS-in-JS for SPA-only routes if you really want it.

First-class CSS-in-JS support, with styles extracted during SSR, depends on upstream work tracked in [pracht#30](https://github.com/JoviDeCroock/pracht/issues/30).

---

## CSS Modules Walkthrough

CSS Modules scope class names to their file by default. Import the module and reference classes from the resulting object:

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

Vite generates unique class names at build time (e.g. `_hero_1a2b3`), so styles never collide across routes. The framework automatically injects only the CSS files used by the current route, its shell, and the islands it rendered.

---

## Tailwind CSS Setup

Install Tailwind's Vite plugin and add it alongside the pracht plugin:

```sh
pnpm add -D @tailwindcss/vite tailwindcss
```

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [pracht({ /* ... */ }), tailwindcss()],
});
```

Import Tailwind in your global CSS or shell:

```css [src/styles/global.css]
@import "tailwindcss";
```

Tailwind classes work in any route regardless of render mode — the generated stylesheet is a static asset that the framework includes in the HTML.
