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

- Every route must be `render: "ssg"` (or `"spa"` — the shell HTML is prerendered). `ssr` and `isg` routes are build errors naming the routes; use `@pracht/adapter-node`, `@pracht/adapter-cloudflare`, or `@pracht/adapter-vercel` for those.
- API routes are build errors.
- Capabilities exposed over HTTP/MCP/WebMCP are build errors (server-only capabilities invoked from build-time loaders are fine).

## Client-side navigation

Loaders run at build time. For each prerendered route that a client navigation would fetch state for, the build serializes the route-state JSON to `dist/client/_pracht/state/<path>/index.json`, and the client router (compiled with `__PRACHT_STATIC_TARGET__`) fetches that file instead of the live route-state endpoint. Navigation therefore stays client-side on a dumb static host.

## Output conventions

- Pages: `<path>/index.html` (clean URLs — hosts must serve `index.html` for directory URLs).
- Route state: `_pracht/state/<path>/index.json`.
- `404.html`: the app's `notFound` page, rendered at build time (GitHub Pages / S3 error-document convention).
- `200.html` (opt-in via `staticAdapter({ fallback: "200.html" })`): SPA fallback document for hosts that can rewrite unmatched URLs; required for deep links into dynamic `render: "spa"` routes.

See `docs/ADAPTERS.md` in the repository for the full documentation, host configuration notes, and limitations.
