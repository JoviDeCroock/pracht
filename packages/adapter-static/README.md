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

- Every route must be `render: "ssg"` or loaderless, full-hydration `"spa"`. SSG loaders run at build time and must produce HTML plus valid JSON route state; loader redirects/errors, successful non-HTML responses, malformed route-state responses, and dynamic SSG routes without `getStaticPaths()` fail the build. Render failures report the underlying error, which the rendered 500 response itself withholds. SPA loaders, non-full SPA hydration, `ssr`, and `isg` are build errors naming the routes; use browser-side fetching for live SPA data or use `@pracht/adapter-node`, `@pracht/adapter-cloudflare`, or `@pracht/adapter-vercel`.
- Route and not-found middleware are build errors because no request runtime exists to enforce them.
- The `notFound` page must use full hydration (the default). A static host serves the same prebuilt `404.html` for every miss, so the full client router is required to adopt the visitor's actual URL.
- API routes are build errors.
- Manifest-registered capabilities exposed over HTTP/MCP/WebMCP are build errors (server-only capabilities invoked from build-time loaders are fine). Registered capability modules must load successfully so validation can fail closed; unused files in the capabilities directory are ignored.
- Route patterns and concrete paths returned by `getStaticPaths()` may not write under the reserved `/_pracht/` namespace. Concrete output is preflighted before any page is written.
- A Vite `base` other than `/` is a build error: prerendered documents reference `/assets/…` and `/_pracht/state/…` from the origin root, so a sub-path deploy (GitHub Pages project site, S3 key prefix) would build cleanly and serve a site whose every asset 404s.

The build also warns — without failing — on a `fallback` document in an app with no `notFound` page and no unshadowed client-routable SPA catch-all (unknown URLs would render blank).

Non-ASCII `getStaticPaths()` params are written to their decoded output path (`/posts/caf%C3%A9` → `posts/café/index.html`), matching how static hosts resolve requests. Escapes that would decode into a path separator, a relative segment, or the reserved `_pracht/` namespace fail the build.

## Client-side navigation

SSG loaders run at build time. For each full-hydration SSG route whose loader or route/shell `head()` metadata participates in client navigation, the build serializes route-state JSON under `dist/client/_pracht/state/` using bounded, collision-safe opaque path components, and the client router (compiled with `__PRACHT_STATIC_TARGET__`) fetches that file instead of the live route-state endpoint. Equivalent URL segment spellings (raw Unicode, lowercase percent escapes, and escaped unreserved characters) resolve to the same state file. Explicitly loaderless and headless routes fetch no Pracht state; loaderless routes with head metadata fetch static state for font-head fragments while their components and data remain browser-only. Dynamic routes with no `getStaticPaths()` export — the usual dynamic `render: "spa"` shape — are prerendered for no path, so the client skips a request that could never hit a file. Navigation therefore stays client-side on a dumb static host.

## Output conventions

- Pages: `<path>/index.html` at the percent-decoded path (clean URLs — hosts must serve `index.html` for directory URLs). `pracht preview` decodes request segments to the same filesystem spelling.
- Route state: bounded, collision-safe opaque `.json` files under `_pracht/state/` (`/` uses `_pracht/state/index.json`). Files copied from `public/` may not occupy a generated state path; the build rejects them instead of overwriting them.
- `404.html`: the app's `notFound` page, rendered independently of ordinary route matching at build time (GitHub Pages / S3 error-document convention).
- `200.html` (opt-in via `staticAdapter({ fallback: "200.html" })`): SPA fallback document for hosts that can rewrite unmatched URLs; required for deep links into dynamic `render: "spa"` routes.

Files copied from `public/` or emitted by Vite may not occupy the generated
`404.html` or configured fallback path, including a case- or
Unicode-normalization-equivalent spelling; the build rejects those portable
collisions instead of overwriting existing output.

One fallback file is shared by every rewritten URL, so it cannot evaluate a
dynamic route or shell `head()` export. When those exports exist, provide
explicit generic metadata shared by every fallback URL:

```ts
staticAdapter({
  fallback: "200.html",
  fallbackHead: { title: "My app", meta: [{ name: "robots", content: "noindex" }] },
});
```

The build fails closed if a dynamic SPA route, its shell, or the not-found page
exports `head()` and `fallbackHead` is omitted.

Fonts in `fallbackHead` remain registered while the fallback commits a
loaderless dynamic SPA route.

The fallback only boots matched SPA routes. Paths matching a dynamic SSG route but omitted by `getStaticPaths()` render the app's `notFound` page rather than running without build-time loader state. When the fallback renders `notFound`, it reuses the loader data or handled error state serialized into `404.html`; the loader does not run again.

Fallback names may not collide with `index.html` or `404.html`, including case variants on case-insensitive filesystems, use a Windows reserved device name, or exceed the portable 255-byte/code-unit component limit.
Prerendered pages must also map to distinct portable filesystem paths. The build rejects duplicate, case-folded, and Unicode-normalization-equivalent outputs; Windows-invalid or overlong filename components; file/directory conflicts such as `/` with `/index.html`; and route directories that occupy `404.html` or the configured fallback file path before writing any page.

A host rewrite to the fallback answers unknown URLs with status 200, so they become soft 404s even though the client renders the `notFound` page. Skip `fallback` when correct 404 statuses matter more than deep links into dynamic SPA routes.

See `docs/ADAPTERS.md` in the repository for the full documentation, host configuration notes, and limitations.
