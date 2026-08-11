# Pages Router Example

Demonstrates pracht's file-based routing mode — no route manifest required.
Routes are derived from the filesystem under `src/pages/`, and API routes live
in `src/api/`.

## File structure

```
src/
  pages/
    _app.tsx          → Shared shell (wraps all pages)
    index.tsx         → /
    about.tsx         → /about
    blog/[slug].tsx   → /blog/:slug
  api/
    health.ts         → GET /api/health
    me.ts             → GET /api/me
  lib/
    with-auth.ts      → Shared auth middleware helper
```

`_app.tsx` is a special file that acts as the shell for all pages, equivalent
to registering a shell in the manifest router. Dynamic segments use `[param]`
bracket syntax in the filename.

## Commands

```sh
pnpm pracht dev        # Dev server with HMR
pnpm pracht build      # Production build (client + server)
node dist/server/server.js  # Run the built server
```

## Configuration

The Vite config enables pages routing by passing `pagesDir` instead of a route
manifest:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages", adapter: nodeAdapter() })],
});
```

All four render modes (SSR, SSG, ISG, SPA) work with the pages router — export
a `RENDER_MODE` constant from any page to opt into a specific mode. ISG also
requires a positive integer time policy:

```ts
export const RENDER_MODE = "isg";
export const REVALIDATE = 3600;
```

Webhook or combined revalidation policies require ejecting to an explicit
manifest. Pages mode also has no registration seam for named shells, route
middleware, capabilities/WebMCP/remote MCP, constraints, or runtime agents.
`REVALIDATE` belongs on each ISG page, never `_app.tsx` or `404.tsx`.
Declarations shown inside Markdown/MDX fenced examples are ignored.
