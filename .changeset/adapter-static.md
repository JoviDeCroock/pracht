---
"@pracht/adapter-static": minor
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-node": patch
---

Add `@pracht/adapter-static`: pure static export. `pracht build` prerenders every route into `dist/client/`, which deploys to any static host (GitHub Pages, S3, nginx, Netlify) with zero server.

- **Fail-closed validation** — `ssr`/`isg` routes, API routes, and HTTP/MCP/WebMCP-exposed capabilities are aggregated build errors naming each offender and pointing at the serverful adapters. Routes under the reserved `/_pracht/` namespace are rejected too.
- **Client navigation without a server** — for each prerendered route whose navigation performs a state fetch, the build serializes the route-state JSON (byte-identical to the live endpoint) to `dist/client/_pracht/state/<path>/index.json`. The client router, compiled with the new `__PRACHT_STATIC_TARGET__` define (driven by the new `PrachtAdapter.staticTarget` flag), fetches those files for navigation, prefetch, SPA boot, and revalidation. Other adapters compile the flag to `false` and keep their behavior byte-for-byte.
- **SPA routes** — `render: "spa"` shells (and their build-time loader payloads) are prerendered. `staticAdapter({ fallback: "200.html" })` emits an SPA fallback document for hosts that can rewrite unmatched URLs, enabling deep links into dynamic SPA routes; a missing state file during a fallback boot renders without loader data instead of looping.
- **404.html** — the app's `notFound` page is rendered at build time (GitHub Pages/S3 convention); the hydrated page adopts `window.location`, so it shows and navigates from the URL actually visited.
- **`pracht preview`** — serves `dist/client/` with a tiny static file server that mirrors a plain host (clean URLs, `404.html`, optional `200.html` rewrite), reusing `@pracht/adapter-node`'s hardened static file resolution (now exported as `resolveStaticFile`/`getCacheControl`).
