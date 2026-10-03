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

Hydration is a per-route setting, so you pick the framework's runtime cost.
These are the client JavaScript totals for the *same page*, rendering the
*same markup*, with one thing changed each time.

| Route setting | Gzip | Raw | What reaches the browser |
| --- | --- | --- | --- |
| `hydration: "none"` | **0 KB** | 0 KB | Nothing. No script tag is emitted. |
| `hydration: "islands"` | **8.0 KB** | 17.6 KB | Preact, the island bootstrap, and the island chunks on the page. |
| `hydration: "full"` | **17.4 KB** | 42.6 KB | The above plus the client router: navigation, prefetching, loader fetches. |
| `hydration: "full"`, prefetching off | **15.9 KB** | 41.6 KB | Full hydration with `client: { prefetch: false }`. |
| `hydration: "full"`, navigation guards off | **17.1 KB** | 41.7 KB | Full hydration with `client: { navigationGuards: false }`. |
| `hydration: "full"`, rich data on | **17.7 KB** | 43.3 KB | Full hydration with `client: { richData: true }`. |
| `hydration: "full"` + `preact/compat` | **18.2 KB** | 44.9 KB | Full hydration with the React compatibility layer in the graph. |

Gzip is a cold load: the route's chunks plus the chunk the router imports
after hydration. Raw is the route's chunks only. Both come from
`bench/baseline.json`, measured with Preact `11.0.0-rc.1` and
render-to-string `6.7.0`. Your application code sits on top of these.

What to read off the table:

- **Islands is the biggest lever.** Going from full hydration to islands
  removes the whole client router.
- **[Prefetching off](/docs/prefetching#shipping-less-javascript) saves about
  1.5 KB.** The router loads the prefetch runtime after hydration, so it counts
  on a cold load without appearing in any route's chunk list.
- **[Navigation guards off](/docs/data-loading#useblocker) saves about
  0.25 KB**, the full cost of `useBlocker()`.
- **[Rich data](/docs/data-loading#dates-maps-and-other-rich-values) costs
  about 0.3 KB**, and only when you turn it on.

### How these numbers are measured

Run the harness from the repository:

```bash
pnpm bench              # bytes and timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift
```

The fixture's routes render identical markup and share one interactive
component; only the hydration mode varies, so each delta is framework runtime.
`preact/compat` is measured in a separate app so it does not inflate the other
rows.

Byte sizes are deterministic, so CI fails when they move. Timings are not, so
the harness reports a median and spread and CI does not gate on them.

### Measuring your own app

`pracht build --analyze` prints the same report for your app, per route:

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

Route totals count the chunks a route loads *to hydrate*. On a full-hydration
route, the browser also fetches the prefetch runtime afterwards, about 1.1 KB
gzip, which no route total includes.

---

## Route-Level Code Splitting

Each route and shell becomes its own JS chunk, loaded only when needed.

The server knows which route and shell it is rendering, so it adds `<link rel="modulepreload">` hints to `<head>`. The browser starts downloading the route's chunks before the client entry runs.

```html
<!-- Automatically injected for the matched route -->
<link rel="modulepreload" href="/assets/home-Bx7kZ3.js" />
<link rel="modulepreload" href="/assets/vendor-D9fK2a.js" />
```

---

## Vendor Chunk

Preact and its hook/compat entry points are extracted into a shared `vendor` chunk. This means:

- The vendor chunk is cached once by the browser and shared across all routes.
- Route chunks stay small — they only contain route-specific code.
- Deploying a route change doesn't invalidate the vendor cache.

### Composing with your own chunking

Pracht adds its Preact group to whatever you configure in
`build.rollupOptions.output`, in the same form you used. Your own groups keep
working alongside the vendor chunk:

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

Rolldown applies higher `priority` first, then declaration order. Your groups
come first, so at equal priority a group of yours that also matches Preact wins.

After a grouping change, check the prerendered HTML, not just the sizes. A broad
group, such as `entriesAware` over everything, can drop the per-route
`<link rel="stylesheet">` tags from `dist/client/**/index.html`. Targeted groups
do not.

To place the framework group yourself, turn the automatic one off and use the
exported definition:

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

`vendorChunk: false` on its own adds no chunking config, which is what you want
if Preact belongs in your app chunks.

## Core Runtime Splitting

Browser builds resolve `@pracht/core` through a client-safe entry, so
server-only runtime code stays out of the browser bundle. The prefetch listeners
load after the router starts, off the hydration critical path.

---

## CSS Per Page

Each response links only the CSS for the matched route, its shell, and the islands it rendered.

For a small site, you can inline those route stylesheets instead:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [pracht({ inlineCss: true })],
});
```

Production HTML then contains `<style data-pracht-inline-css>` instead of the
stylesheet links. It works with both routers, every render and hydration mode,
and every built-in adapter. Development keeps links so HMR works.

Inlining saves a render-blocking request but enlarges every HTML response and
repeats shared CSS on every page. It inlines whole files, not critical
selectors. Choose by how your pages are visited:

- **Visitors move between pages** (most apps): link. One cached stylesheet
  serves the whole session.
- **Cold, single-page visits** (static and content sites from search): inline.
  The cache is never reused, and on a page with little JavaScript the
  stylesheet is the render-blocking request that delays first paint.

The default is `false`. When a static export's pages each link a small
stylesheet, `pracht build` prints a tip suggesting the flag. Measure both
before choosing.

Under a nonce-based CSP, return `styleNonce` from `head()` and put the same
nonce in `style-src`. For SSG/ISG pages, prefer linked CSS unless a stable hash
policy covers the inline block.

---

## Real-User Web Vitals

Mount a small component in a shared shell to receive CLS, FCP, INP, LCP, and
TTFB:

```tsx [src/components/vitals.tsx]
import { useWebVitals } from "@pracht/core";

export function Vitals() {
  useWebVitals((metric) => {
    navigator.sendBeacon(
      "/api/telemetry/vitals",
      JSON.stringify({
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        id: metric.id,
        path: location.pathname,
      }),
    );
  });
  return null;
}
```

The hook is SSR-safe and loads its measurement code after mount; apps that
never call it ship none. Some metrics arrive only after interaction or on page
exit, so send them with `sendBeacon()` or another unload-safe transport.

---

## Error Overlay in Dev

When a loader or component throws during SSR in `pracht dev`, pracht shows an error overlay with the error message, a source-mapped stack trace, and the failing route ID and file when known. It reloads automatically when you save a fix.

> [!NOTE]
> Production builds return standard error responses, or render your route's `ErrorBoundary` if it exports one.

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
