# @pracht/adapter-static

Pure static export for pracht — the `adapter-static` / `output: "export"` of the framework. `pracht build` prerenders every route into `dist/client/`, and that directory deploys to any static host (GitHub Pages, S3, nginx, Netlify) with zero server.

## Install

```bash
npm install @pracht/adapter-static
```

## Usage

```ts
// vite.config.ts
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default {
  plugins: [pracht({ adapter: staticAdapter() })],
};
```

Then:

```bash
pracht build      # writes the deployable site to dist/client/
pracht preview    # serves dist/client/ locally with a tiny static file server
```

## What must hold

A static export has no server, so the build fails closed on anything that needs one:

- Every route must be `render: "ssg"` or loaderless `"spa"`. SSG loaders run at build time and must succeed; loader redirects/errors and dynamic SSG routes without `getStaticPaths()` fail the build. SPA loaders, `ssr`, and `isg` are build errors naming the routes; use browser-side fetching for live SPA data or use `@pracht/adapter-node`, `@pracht/adapter-cloudflare`, or `@pracht/adapter-vercel`.
- Route and not-found middleware are build errors because no request runtime exists to enforce them.
- API routes are build errors.
- Manifest-registered capabilities exposed over HTTP/MCP/WebMCP are build errors (server-only capabilities invoked from build-time loaders are fine). Registered capability modules must load successfully so validation can fail closed; unused files in the capabilities directory are ignored.

## Client-side navigation

SSG loaders run at build time. For each loader-backed SSG route, the build serializes route-state JSON to `dist/client/_pracht/state/<path>/index.json`, and the client router (compiled with `__PRACHT_STATIC_TARGET__`) fetches that file instead of the live route-state endpoint. Loaderless SPA routes fetch no Pracht state and run entirely in the browser. Navigation therefore stays client-side on a dumb static host.

## Output conventions

- Pages: `<path>/index.html` (clean URLs — hosts must serve `index.html` for directory URLs).
- Route state: `_pracht/state/<path>/index.json`.
- `404.html`: the app's `notFound` page, rendered at build time (GitHub Pages / S3 error-document convention).
- `200.html` (opt-in via `staticAdapter({ fallback: "200.html" })`): SPA fallback document for hosts that can rewrite unmatched URLs; required for deep links into dynamic `render: "spa"` routes.

The fallback only boots matched SPA routes. Paths matching a dynamic SSG route but omitted by `getStaticPaths()` render the app's `notFound` page rather than running without build-time loader state.

Fallback names may not collide with `index.html` or `404.html`, including case variants on case-insensitive filesystems.

See `docs/ADAPTERS.md` in the repository for the full documentation, host configuration notes, and limitations.
