---
title: Styling
lead: Pracht optimizes style loading for CSS that exists at build time. Prefer CSS Modules, Tailwind, or plain stylesheets over runtime CSS-in-JS — especially on server-rendered routes.
breadcrumb: Styling
prev:
  href: /docs/shells
  title: Shells
next:
  href: /docs/cli
  title: CLI
---

## Recommended Approaches

Any of these produce real CSS files that Vite tracks through its module graph. Pracht uses that graph to inject only the stylesheets a route actually needs — no unused CSS is sent, and the critical styles ship in the initial HTML.

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

---

## CSS-in-JS — Use With Care

Runtime CSS-in-JS libraries like **styled-components**, **Emotion**, and **goober** work in a pracht app, but the framework currently cannot collect their runtime-generated styles and inline them into the server-rendered HTML.

| Route mode        | CSS-in-JS support                                                 |
| ----------------- | ----------------------------------------------------------------- |
| `spa` (CSR only)  | ✅ Works — styles are injected on the client after mount           |
| `ssr` / `ssg` / `isg` | ⚠️ Flash of unstyled content until hydration catches up       |

> [!WARNING]
> On server-rendered routes, runtime CSS-in-JS produces HTML without the matching `<style>` tags. The page paints unstyled, then re-paints after hydration — a noticeable flash, and not good for Core Web Vitals.

**Guidance:** pick a build-time approach (CSS Modules, Tailwind, plain CSS) for any route that runs on the server. Keep CSS-in-JS for SPA-only routes if you really want it.

---

## Future Work

First-class CSS-in-JS support — where pracht extracts critical styles during SSR and inlines them into the HTML — is contingent on upstream work tracked in [pracht#30](https://github.com/JoviDeCroock/pracht/issues/30). Once that lands, runtime CSS-in-JS libraries will have a path to render without a flash on server-rendered routes, and this recommendation will be revisited.

Until then, reach for CSS Modules or Tailwind first.
