---
title: Performance
lead: What pracht adds to a page, how it is measured, and the code splitting and preloading you get without configuration.
---

## What pracht costs a page

Hydration is a per-route setting, so you choose the framework's runtime cost. These are the client JavaScript totals for the *same page*, rendering the *same markup*, with one setting changed each time.

| Route setting | Gzip | Raw | What reaches the browser |
| --- | --- | --- | --- |
| `hydration: "none"` | **0 KB** | 0 KB | Nothing. No script tag is emitted. |
| `hydration: "islands"` | **8.1 KB** | 18.1 KB | Preact, the island bootstrap, and the island chunks on the page. |
| `hydration: "islands"`, islands navigation on | **11.8 KB** | 27.9 KB | Islands with `client: { islandsNavigation: true }`. |
| `hydration: "full"` | **17.4 KB** | 41.5 KB | The above plus the client router: navigation, prefetching, loader fetches. |
| `hydration: "full"`, prefetching off | **15.7 KB** | 40.5 KB | Full hydration with `client: { prefetch: false }`. |
| `hydration: "full"`, navigation guards off | **17.2 KB** | 40.7 KB | Full hydration with `client: { navigationGuards: false }`. |
| `hydration: "full"`, rich data on | **17.7 KB** | 42.2 KB | Full hydration with `client: { richData: true }`. |
| `hydration: "full"` + `preact/compat` | **18.1 KB** | 44.0 KB | Full hydration with the React compatibility layer in the graph. |

Gzip is a cold load: the route's chunks plus the chunk the router imports
after hydration. Raw is the route's chunks only. Both come from
`bench/baseline.json`, measured with Preact `11.0.1` and
render-to-string `6.7.0`. Your application code sits on top of these.

The settings that move the total:

| Setting | Effect on gzip |
| --- | --- |
| Islands instead of full hydration | Removes the whole client router |
| [Prefetching off](/docs/prefetching#shipping-less-javascript) | Saves about 1.6 KB. The router loads the prefetch runtime after hydration, so it counts on a cold load but appears in no route's chunk list |
| [Navigation guards off](/docs/reference/hooks#useblocker) | Saves about 0.25 KB, the full cost of `useBlocker()` |
| [Accessible navigation](/docs/reference/config#client-bundle) off | Saves about 0.3 KB; turn it off only if the app moves focus and announces pages itself |
| [Rich data](/docs/data-loading#dates-maps-and-other-rich-values) on | Costs about 0.3 KB |
| [Islands navigation](/docs/islands#client-side-navigation-between-islands-pages) on | Costs about 3.8 KB on islands pages; an islands page without islands then loads about 11 KB instead of nothing |

### How these numbers are measured

Run the harness from the repository:

```bash
pnpm bench              # bytes and timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift
```

The fixture's routes render identical markup and share one interactive component. Only the hydration mode varies, so each delta is framework runtime. `preact/compat` is measured in a separate app so it does not inflate the other rows.

CI fails when byte sizes move, because they are deterministic. Timings are not, so the harness reports a median and spread and CI does not gate on them.

### Measuring your own app

Run `pracht build --analyze` to print the same report for your app, per route:

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

Add `--json` for machine-readable output, and set per-route [budgets](/docs/reference/config) to fail a build when a route ships too much.

Route totals count the chunks a route loads *to hydrate*. On a full-hydration route, the browser also fetches the prefetch runtime afterwards, about 1.2 KB gzip, which no route total includes.

## Route-level code splitting

Each route and shell becomes its own JS chunk, loaded only when needed.

The server knows which route and shell it renders, so it adds `<link rel="modulepreload">` hints to `<head>`. The browser starts downloading the route's chunks before the client entry runs.

```html
<!-- Injected for the matched route -->
<link rel="modulepreload" href="/assets/home-Bx7kZ3.js" />
<link rel="modulepreload" href="/assets/vendor-D9fK2a.js" />
```

Browser builds resolve `@pracht/core` through a client-safe entry, so server-only runtime code stays out of the bundle. The prefetch listeners load after the router starts, off the hydration critical path.

## Vendor chunk

Preact and its hooks and compat entry points go into a shared `vendor` chunk. The browser caches it once for every route, route chunks hold only route code, and deploying a route change does not invalidate the vendor cache.

### Composing with your own chunking

Add your own groups under `build.rollupOptions.output`; pracht adds its Preact group to them in the same form:

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

Rolldown applies higher `priority` first, then declaration order. Your groups come first, so at equal priority a group of yours that also matches Preact wins.

After a grouping change, check the prerendered HTML, not just the sizes. A broad group, such as `entriesAware` over everything, can drop the per-route `<link rel="stylesheet">` tags from `dist/client/**/index.html`. Targeted groups do not.

To place the framework group yourself, turn the automatic one off and spread the exported definition:

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

`vendorChunk: false` on its own adds no chunking config, which keeps Preact in your app chunks.

## CSS per page

Each response links only the CSS for the matched route, its shell, and the islands it rendered. To inline those stylesheets instead, set `inlineCss`:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [pracht({ inlineCss: true })],
});
```

Production HTML then contains `<style data-pracht-inline-css>` instead of the stylesheet links. It works with both routers, every render and hydration mode, and every built-in adapter. Development keeps links so HMR works.

Inlining saves a render-blocking request but enlarges every HTML response and repeats shared CSS on every page. It inlines whole files, not critical selectors. Choose by how your pages are visited:

| Visit pattern | Choose |
| --- | --- |
| Visitors move between pages (most apps) | Link (the default). One cached stylesheet serves the session |
| Cold, single-page visits (static and content sites from search) | Inline. The cache is never reused, and the stylesheet is the request that delays first paint |

When a static export's pages each link a small stylesheet, `pracht build` prints a tip suggesting the flag. Measure both before choosing.

Under a nonce-based CSP, return `styleNonce` from `head()` and put the same nonce in `style-src`. For SSG and ISG pages, prefer linked CSS unless a stable hash policy covers the inline block.

## Early hints

A rendered page whose `<head>` links stylesheets or preloads [fonts](/docs/fonts) answers with a `Link` header listing them. Prerendered SSG and ISG pages carry the same header on the Node, Cloudflare, Vercel, and Netlify adapters. Stylesheets inlined with `inlineCss` are not listed.

```http
Link: </assets/app-D1x9.css>; rel=preload; as=style
```

On Cloudflare, turn on **Early Hints** under *Speed › Settings › Content Optimization*. The CDN caches the header and sends it as a `103 Early Hints` response ahead of later requests for the page, so the browser downloads stylesheets and fonts while your loader runs.

Set `earlyHints: true` on the Node adapter to send the `103` itself, including the page's scripts, once route middleware has passed and before the loaders run:

```ts [vite.config.ts]
nodeAdapter({ earlyHints: true });
```

Browsers act on a `103` only over HTTP/2 or HTTP/3, so this helps when an HTTP/2 proxy in front of the server forwards it. It is off by default because some proxies mistake a `103` for the final response.

## Real-user Web Vitals

Mount a component in a shared shell to receive CLS, FCP, INP, LCP, and TTFB:

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

The hook is SSR-safe and loads its measurement code after mount; apps that never call it ship none. Some metrics arrive only after interaction or on page exit, so send them with `sendBeacon()` or another unload-safe transport.

## Error overlay in dev

When a loader or component throws during SSR in `pracht dev`, the page shows an error overlay with the message, a source-mapped stack trace, and the failing route ID and file when known. It reloads when you save a fix.

Production builds return standard error responses, or render the route's `ErrorBoundary` if it exports one.

## Defaults

A standard pracht app gets these without configuration:

| Optimization         | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| Route code splitting | Each route is a separate JS chunk, loaded on demand          |
| Modulepreload hints  | The browser downloads route JS before the client entry runs  |
| Vendor extraction    | Preact is cached once, shared across routes                  |
| Core runtime splitting | Server runtime and prefetch setup stay off the critical path |
| Per-page CSS         | Only CSS for the matched route and shell is included         |
| `Link` preload header | CDNs with Early Hints start stylesheet and font downloads before the HTML |
| Intent prefetching   | Route data is fetched on hover or focus before the click     |
| Dev error overlay    | Framework-aware errors that reload when you save a fix       |
