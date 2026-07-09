---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Islands architecture (partial hydration). Routes can now opt into `hydration: "islands"` (or `"none"`) alongside their render mode — in the manifest router via `route(path, file, { render: "ssg", hydration: "islands" })` (inherited through `group(...)`), and in the pages router via `export const HYDRATION = "islands"`. The default stays `"full"`, so existing apps are unchanged.

Interactive components live in an islands directory (default `src/islands/`, configurable via `pracht({ islandsDir })`) and are auto-discovered: a Preact `options.vnode` hook detects island components during islands-mode renders — no wrappers at call sites. The server wraps each island's SSR output in a `<pracht-island>` marker with JSON-serialized props and emits clear dev errors for non-serializable props (naming the offending prop path) and for children/slots passed into islands (unsupported in v1). Per-usage hydration strategies via the framework-owned `client` prop: `load` (default, modulepreloaded), `idle` (requestIdleCallback), and `visible` (IntersectionObserver; the chunk is fetched only when the island scrolls into view).

Islands routes ship a tiny bootstrap (`virtual:pracht/islands-client`) instead of the client runtime/router: it scans the DOM for markers and dynamically imports only the islands present on the page (each island is its own code-split chunk). Pages that render zero islands — and `hydration: "none"` routes — ship no JavaScript at all. Navigation to, from, and between islands routes is MPA-style full-document navigation in v1; the client router deliberately falls back to `window.location` and skips prefetching for these routes.

`pracht build --analyze` attributes islands routes honestly: the islands bootstrap plus island chunks (an upper bound — per-page usage is only known at render time) with no shared client entry, and `0b` for `hydration: "none"` routes. Budgets apply to these totals. See `docs/ISLANDS.md` and `examples/islands`.
