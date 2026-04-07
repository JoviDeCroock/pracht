---
title: Performance
lead: viact optimizes page load performance through automatic code splitting, module preloading, and vendor chunk extraction — with zero configuration.
breadcrumb: Performance
prev:
  href: /docs/prefetching
  title: Prefetching
---

## Route-Level Code Splitting

Every route and shell module is loaded via `import.meta.glob()`, which Vite compiles into dynamic imports. Each route becomes its own JS chunk, loaded only when needed.

On the server, viact knows which route and shell are being rendered. It uses this to emit `<link rel="modulepreload">` hints in the HTML `<head>` so the browser can start downloading the matched route's JS chunks immediately — before the client entry script even executes.

```html
<!-- Automatically injected for the matched route -->
<link rel="modulepreload" href="/assets/home-Bx7kZ3.js">
<link rel="modulepreload" href="/assets/vendor-D9fK2a.js">
```

---

## Vendor Chunk

Preact, preact/hooks, and preact-suspense are extracted into a shared `vendor` chunk. This means:

- The vendor chunk is cached once by the browser and shared across all routes.
- Route chunks stay small — they only contain route-specific code.
- Deploying a route change doesn't invalidate the vendor cache.

---

## CSS Per Page

viact builds a CSS manifest that maps each source file to its transitive CSS dependencies. At request time, only the CSS needed for the matched route and shell is injected as `<link rel="stylesheet">` tags — no unused CSS is sent.

---

## Error Overlay in Dev

During development, if a loader or component throws an error during server-side rendering, viact renders a framework-aware error overlay instead of a generic Vite error page.

The overlay shows:

- The error message and name
- A source-mapped stack trace (with Vite's SSR stack fix applied)
- The route ID and file path that failed (when available)

The overlay auto-reloads when you save a fix — it listens for Vite's HMR full-reload event and refreshes the page automatically.

> [!NOTE]
> The error overlay only appears during `viact dev`. Production builds return standard error responses (or render your `ErrorBoundary` component if one is exported from the route module).

---

## What You Get For Free

None of these optimizations require configuration. A standard viact app automatically gets:

| Optimization | What It Does |
|-------------|-------------|
| Route code splitting | Each route is a separate JS chunk, loaded on demand |
| Modulepreload hints | Browser starts downloading route JS before client entry runs |
| Vendor extraction | Preact is cached once, shared across routes |
| Per-page CSS | Only CSS for the matched route/shell is included |
| Intent prefetching | Route data is fetched on hover/focus before click |
| Dev error overlay | Framework-aware errors with auto-reload on fix |
