---
title: Performance
lead: What pracht costs a page, how those numbers are measured, and the automatic code splitting, module preloading, and vendor chunk extraction you get without configuring anything.
breadcrumb: Performance
prev:
  href: /docs/prefetching
  title: Prefetching
next:
  href: /docs/agents
  title: The Agentic Web
---

## What pracht costs a page

Hydration is a per-route setting, so the framework's runtime cost is something
you pick rather than something you inherit. These are the gzipped client
JavaScript totals for the *same page*, rendering the *same markup*, with one
thing changed each time.

| Route setting | Gzip | Raw | What reaches the browser |
| --- | --- | --- | --- |
| `hydration: "none"` | **0 KB** | 0 KB | Nothing. No script tag is emitted. |
| `hydration: "islands"` | **7.4 KB** | 16.9 KB | Preact, the island bootstrap, and the island chunks on the page. |
| `hydration: "full"` | **16.3 KB** | 40.1 KB | The above plus the client router: navigation, prefetching, loader fetches. |
| `hydration: "full"`, prefetching off | **14.8 KB** | 39.2 KB | Full hydration with `client: { prefetch: false }`. |
| `hydration: "full"`, navigation guards off | **16.0 KB** | 39.2 KB | Full hydration with `client: { navigationGuards: false }`. |
| `hydration: "full"` + `preact/compat` | **17.8 KB** | 44.7 KB | Full hydration with the React compatibility layer in the graph. |

Gzip is a cold load — the route's chunks plus the one the router fetches after
hydration. Raw is the route's chunks. Both come straight from
`bench/baseline.json`, so every number here is one command away from being
checked.

Your application code sits on top of these. They are a floor, not a budget.

Three things worth reading off the table. Going from full hydration to islands
is the single largest lever — it removes the router, not just some of it.
[Turning prefetching off](/docs/prefetching) is worth about 1.5 KB, which is
more than it looks: the router `import()`s the prefetch runtime *after*
hydration, so those bytes are part of a cold load without showing up in any
route's chunk list. And
[turning navigation guards off](/docs/data-loading#useblocker) is worth about
0.3 KB — small, but it is the entire cost of a feature an app either uses or
does not.

### How these numbers are measured

They come from `pnpm bench`, which lives in the repository and anyone can run:

```bash
pnpm bench              # bytes and timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift
```

The fixture is one app whose routes render identical markup and share a single
interactive component. The only variable between rows is the hydration mode, so
a delta is framework runtime rather than application code. `preact/compat` is
measured in a separate app on purpose: it lands in the shared vendor chunk, and
measuring it in the same build would inflate every other row.

Byte sizes are deterministic for a given commit, so they are recorded in a
baseline and CI fails when they move — a stray import that pulls a new module
into the client entry becomes a failing pull request. Timings are not
deterministic, so the harness reports a median with its observed spread and
nothing in CI gates on them.

### Measuring your own app

`pracht build --analyze` prints the same shape of report for the app you are
actually building, per route:

```bash
pracht build --analyze
```

```
Route / chunk                        Gzip     Raw
/dashboard (ssr)
  /assets/dashboard-BCIbC3P5.js      744b   1.3kb
  /assets/app-CyBulJul.js            257b    447b
  total (incl. shared)             13.1kb  32.0kb
```

Add `--json` for machine-readable output, and set per-route
[budgets](/docs/reference/config) to fail a build when a route ships too much.

One caveat the report shares with every bundle analyzer: it accounts for the
chunks a route loads *to hydrate*. Runtime the router imports afterwards — the
prefetch runtime today, roughly 1.1 KB gzip — is fetched by the browser on a
full-hydration route without appearing in a route total. The table above quotes
the cold-load number, which includes it.

---

## Route-Level Code Splitting

Every route and shell module is loaded via `import.meta.glob()`, which Vite compiles into dynamic imports. Each route becomes its own JS chunk, loaded only when needed.

On the server, pracht knows which route and shell are being rendered. It uses this to emit `<link rel="modulepreload">` hints in the HTML `<head>` so the browser can start downloading the matched route's JS chunks immediately — before the client entry script even executes.

```html
<!-- Automatically injected for the matched route -->
<link rel="modulepreload" href="/assets/home-Bx7kZ3.js" />
<link rel="modulepreload" href="/assets/vendor-D9fK2a.js" />
```

---

## Vendor Chunk

Preact, preact/hooks, and preact-suspense are extracted into a shared `vendor` chunk. This means:

- The vendor chunk is cached once by the browser and shared across all routes.
- Route chunks stay small — they only contain route-specific code.
- Deploying a route change doesn't invalidate the vendor cache.

### Composing with your own chunking

The framework group is *contributed*, not imposed. Whatever you configure in
`build.rollupOptions.output` stays, and pracht appends its Preact group in the
same form you used — so grouping a feature into its own chunk does not cost you
the vendor chunk:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [pracht()],
  build: {
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "editor", test: /src[\\/]features[\\/]editor/ }],
        },
      },
    },
  },
});
```

Precedence is Rolldown's own: higher `priority` first, then declaration order.
Your groups are declared first, so a group that would also capture Preact wins
at equal priority and pracht's group takes only what nothing else claimed.

Check the prerendered HTML after a grouping change, not only the sizes. A broad
group — `entriesAware` over everything, for instance — can reshuffle entry
chunks enough that the per-route `<link rel="stylesheet">` tags pracht injects
disappear from `dist/client/**/index.html`. Targeted groups do not have this
problem; measure the pages, not just the bundle report.

To place the framework group yourself — at a different priority, or merged into
one of your own — turn the automatic one off and use the exported definition:

```ts [vite.config.ts]
import { frameworkChunkGroups, pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ vendorChunk: false })],
  build: {
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            ...frameworkChunkGroups(),
            { name: "editor", test: /src[\\/]features[\\/]editor/ },
          ],
        },
      },
    },
  },
});
```

`vendorChunk: false` on its own makes pracht contribute no chunking config at
all, which is what you want if Preact belongs in your app chunks.

## Core Runtime Splitting

The generated client entry imports a lean browser bootstrap from `@pracht/core/client`.
Route and shell modules still import the normal `@pracht/core` API, but browser
builds resolve that public API through a client-safe entry so server-only
runtime code is not part of the default browser graph.

Prefetch listener setup is also loaded after the router is initialized. The
small route-state cache remains available synchronously for navigation and
forms, while the hover/focus and viewport observers move out of the hydration
critical path.

---

## CSS Per Page

pracht builds a CSS manifest that maps each source file to its transitive CSS dependencies. At request time, only the CSS needed for the matched route and shell is injected as `<link rel="stylesheet">` tags — no unused CSS is sent.

---

## Error Overlay in Dev

During development, if a loader or component throws an error during server-side rendering, pracht renders a framework-aware error overlay instead of a generic Vite error page.

The overlay shows:

- The error message and name
- A source-mapped stack trace (with Vite's SSR stack fix applied)
- The route ID and file path that failed (when available)

The overlay auto-reloads when you save a fix — it listens for Vite's HMR full-reload event and refreshes the page automatically.

> [!NOTE]
> The error overlay only appears during `pracht dev`. Production builds return standard error responses (or render your `ErrorBoundary` component if one is exported from the route module).

---

## What You Get For Free

None of these optimizations require configuration. A standard pracht app automatically gets:

| Optimization         | What It Does                                                 |
| -------------------- | ------------------------------------------------------------ |
| Route code splitting | Each route is a separate JS chunk, loaded on demand          |
| Modulepreload hints  | Browser starts downloading route JS before client entry runs |
| Vendor extraction    | Preact is cached once, shared across routes                  |
| Core runtime splitting | Server runtime and prefetch setup stay off the critical path |
| Per-page CSS         | Only CSS for the matched route/shell is included             |
| Intent prefetching   | Route data is fetched on hover/focus before click            |
| Dev error overlay    | Framework-aware errors with auto-reload on fix               |
