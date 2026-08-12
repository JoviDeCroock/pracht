---
"@pracht/adapter-static": minor
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-node": patch
---

Add `@pracht/adapter-static`: pure static export. `pracht build` prerenders every route into `dist/client/`, which deploys to any static host (GitHub Pages, S3, nginx, Netlify) with zero server.

- **Fail-closed validation** — `ssr`/`isg` routes, SPA loaders, route/not-found middleware, non-full-hydration not-found pages, API routes, and HTTP/MCP/WebMCP-exposed registered capabilities are aggregated build errors naming each offender and pointing at the serverful adapters. Missing or unloadable registered capability modules fail closed, unused capability-directory files are ignored, routes under the reserved `/_pracht/` namespace are rejected, and dynamic SSG routes without `getStaticPaths()` fail instead of being skipped.
- **Build-time loader outcomes** — SSG loaders run during prerender. Redirecting or failed document/route-state renders now fail the static build instead of warning, skipping the route, and producing a successful but incomplete export.
- **Client navigation without a server** — for each loader-backed SSG route, the build renders the route-state request a second time and serializes the JSON to `dist/client/_pracht/state/<path>/index.json` (loaders run twice per page and must be build-time deterministic, like `getStaticPaths`). The client router, compiled with the new `__PRACHT_STATIC_TARGET__` define, fetches those files for navigation, prefetch, and revalidation. The new `PrachtAdapter.staticTarget` flag also drives CLI artifact generation independently of the adapter id; other adapters compile the flag to `false` and keep their behavior byte-for-byte.
- **SPA routes** — static `render: "spa"` routes must be loaderless, including supported TSRX route modules whose loader-free status is inferred at build time. Their shell HTML is prerendered, they boot without pending route state, and in-app navigation renders them entirely client-side. Use browser-side fetches to external APIs for live data. `staticAdapter({ fallback: "200.html" })` emits an SPA fallback document for hosts that can rewrite unmatched URLs, enabling deep links into dynamic SPA routes while routing ungenerated dynamic SSG matches to the app's not-found page with its build-time loader data.
- **404.html** — the app's full-hydration `notFound` page is rendered independently of ordinary route matching at build time (GitHub Pages/S3 convention), so broad dynamic routes cannot suppress it; the hydrated page adopts `window.location`, so it shows and navigates from the URL actually visited.
- **`pracht preview`** — serves `dist/client/` with a tiny static file server that mirrors a plain host (clean URLs, `404.html`, optional `200.html` rewrite), reusing `@pracht/adapter-node`'s hardened static file resolution (now exported as `resolveStaticFile`/`getCacheControl`).
