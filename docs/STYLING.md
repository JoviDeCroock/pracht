# Styling

Pracht does not prescribe a styling solution — any approach that runs through
Vite will work. That said, the framework can only optimize style loading for
solutions that emit CSS at build time. This page lays out the recommendation
and the reasoning behind it.

---

## Recommended

Prefer styling approaches that produce real CSS files:

- **CSS Modules** — co-located, scoped by filename hash
- **Tailwind CSS** — utility-first, emitted as a single stylesheet via
  `@tailwindcss/vite`
- **Plain `.css` / `.scss` imports** — scoped by convention or by being
  imported from a single module
- **PostCSS** pipelines (Open Props, Pico, etc.) — anything that ends up as a
  static stylesheet

These all produce CSS that Vite tracks through its module graph. Pracht's build
maps each route and shell to its transitive CSS dependencies, then injects only
the relevant `<link rel="stylesheet">` tags into the server-rendered HTML. See
[RENDERING_MODES.md](RENDERING_MODES.md) and the per-page CSS section in the
performance docs.

---

## CSS-in-JS

Runtime CSS-in-JS libraries (styled-components, Emotion, goober in runtime
mode, etc.) work, but with caveats:

- On **SPA** / **CSR** routes they are fine — styles are injected by the
  library on the client during first render.
- On **SSR** / **SSG** / **ISG** routes the framework currently has no way to
  collect runtime-generated styles and inline them into the critical path.
  Users will see a flash of unstyled content before hydration finishes and the
  library catches up.

Because of that, CSS-in-JS is **not recommended for server-rendered routes**
today. Pick a build-time approach for anything that needs to render on the
server, and keep CSS-in-JS for client-only views if you really want it.

---

## Future work

First-class support for CSS-in-JS with server-side extraction is contingent on
upstream work in Preact tracked in
[JoviDeCroock/pracht#30](https://github.com/JoviDeCroock/pracht/issues/30).
Once that lands, pracht can wire the extracted critical styles into the SSR
HTML the same way it does for build-time CSS, and this recommendation will be
revisited.

Until then: reach for CSS Modules or Tailwind first.
