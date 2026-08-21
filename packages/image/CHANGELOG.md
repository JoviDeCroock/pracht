# @pracht/image

## 0.3.0

### Minor Changes

- [#318](https://github.com/JoviDeCroock/pracht/pull/318) [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support Vite `base` — deploying under a sub-path instead of an origin root.
  
  `base: "/my-project/"` now produces a working deploy for a GitHub Pages *project* site, an S3 key prefix, or a reverse-proxy mount. Previously a static export rejected any non-`/` base at build time, because prerendered asset and route-state URLs were root-relative. Adapter-owned development servers serve the base-prefixed client bootstrap and companion endpoints directly, and preserve redirects that their development asset binding has already based.
  
  The base is where the deploy is *served*, not part of the output tree: `dist/client/` still contains `about/index.html`. What changes is every URL the framework emits — `<script src>`, CSS and modulepreload links, `/_pracht/state/…` fetches and preloads, `llms.txt` links, speculation-rules `href_matches` patterns, root-absolute `redirect()` destinations, `apiFetch()` and capability requests (including a `<Form capability>` action attribute), `@pracht/image`'s default optimization endpoint, OpenAPI reference-document links and default server, and hrefs built by `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`. Published Pracht runtime packages are bundled into non-edge SSR builds so Vite applies the configured base consistently outside the monorepo too. Route matching strips the base on both sides (the client router and `handlePrachtRequest`), so manifest route paths stay base-free, while application `Request`/`url` values and `useLocation()` report the URL as the visitor sees it — prerendered documents included, and serverful deployments restore the configured base after a reverse proxy strips it. `pracht dev`, `pracht preview`, and first-party production adapters serve the app under the configured base; devtools and dev-404 links remain inside it, while every host redirects the bare `/my-project` to the query-preserving `/my-project/` form before serving the root document. Anything outside the base remains a 404. Adapter-owned development servers also match base-prefixed requests against the correct route before injecting initial route and shell stylesheets.
  
  Root-absolute strings passed to imperative `prefetch()` remain base-free route paths and receive the configured deploy base before matching and fetching. Absolute and protocol-relative URLs keep their existing URL semantics.
  
  `withBase()`, `stripBase()`, and `PRACHT_BASE` are exported from `@pracht/core` for URLs you build yourself.
  
  Two deliberate boundaries:
  
  - Hand-written root-absolute links are not rewritten. `<a href="/about">` means the origin root in HTML, matching Next's `basePath` and SvelteKit's `base`; use `<Link route="about">` or `href("about")` for internal navigation. A same-origin link outside the base is handed to the browser instead of matched as a route.
  - A cross-origin base (`https://cdn.example.com/`, or protocol-relative `//cdn…`) stays a static-export build error. It relocates only assets while documents and the route-state tree remain at the origin root, and a static export serves all three from one deploy root. Document-relative bases (`""` and `"./"`) are rejected too because their asset URLs resolve beneath each nested prerendered page directory; use a root-absolute path base instead.
  - A root-absolute base must contain safe URL segments. Repeated slashes, malformed escapes, and segments that decode to a path separator, `.`, `..`, NUL, or another control character are rejected. Percent-equivalent spellings match canonically at runtime. Static validation also retains document-relative bases supplied by companion Vite plugins so SSR normalization cannot hide them.
  
  A sub-path base is wired end to end for static exports. Serverful adapters emit the same base-carrying URLs and strip the base before route matching. The Node adapter maps a retained public base onto its base-free static-file and ISG-manifest keys; when a trusted proxy strips the base before forwarding instead, declare that rewrite with `nodeAdapter({ basePathStripped: true })`. The explicit contract prevents a route whose first segment matches the base from being stripped twice, including a route equal to the base segment itself. In stripped mode the proxy owns the public bare-base redirect because the upstream cannot distinguish it from that legitimate route.
  
  Cloudflare keeps asset-binding redirects and Workers Caching purge paths inside the public base. Netlify bundles the base-free client tree when its static layer cannot map base-prefixed URLs onto it, including files whose literal origin-root URLs use a custom function bypass. Unsafe root-absolute bases now fail during Vite config resolution for every adapter, and dev error-overlay editor requests use the configured base.
  
  With the default base of `/`, `withBase()` and `stripBase()` are the identity and output is byte-for-byte unchanged.

## 0.2.0

### Minor Changes

- [#304](https://github.com/JoviDeCroock/pracht/pull/304) [`72a24ec`](https://github.com/JoviDeCroock/pracht/commit/72a24ec3bd2525394cdf43be5a299b3eb8819f37) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add build-time image imports and blur placeholders.
  
  - New `@pracht/image/vite` entry exports `prachtImage()`, an opt-in Vite
    plugin that turns `import hero from "./hero.jpg?pracht"` into typed
    metadata `{ src, width, height, blurDataURL }`. The file goes through
    Vite's normal asset pipeline (hashed source assets, stable `publicDir` URLs,
    `base`, and dev serving) with inlining disabled (`no-inline`), so `src` is
    always a real URL — never a `data:` URI — and stays compatible with
    optimization-endpoint loaders; the dimensions come from sharp metadata
    with EXIF orientation applied, and
    `blurDataURL` is a tiny inline WebP generated at build time. sharp remains
    an optional peer dependency, required only at build time for `?pracht`
    imports, with a clear install hint when missing. SVG imports pass their
    dimensions through without a blur; animated GIFs blur their first frame;
    CMYK JPEGs convert to sRGB.
  - `<Image>` now accepts a `?pracht` metadata object as `src` (intrinsic
    dimensions and `blurDataURL` applied automatically, explicit props win),
    plus `placeholder="blur"` and `blurDataURL` props. The placeholder renders
    as a CSS-only background on the `<img>` — SSR-safe, zero hydration, no
    inline event handlers — and `blurDataURL` values are validated as
    well-formed `data:image/…` URIs before being interpolated into the style
    attribute.
  - New `@pracht/image/client` types entry ships the `*?pracht` module
    declaration: reference it with `/// <reference types="@pracht/image/client" />`
    or `"types": ["@pracht/image/client"]`.

### Patch Changes

- [#293](https://github.com/JoviDeCroock/pracht/pull/293) [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Widen the `preact` peer range to accept 11.x prereleases.
  
  The peer was `^10.0.0` (`^10.26.0` for the precompiler), so installing pracht
  alongside `preact@11.0.0-beta.x` or `11.0.0-rc.0` printed peer warnings on
  every install even though nothing was actually broken. The range is now
  `^10.0.0 || ^11.0.0-0`, matching what `preact-render-to-string` already
  declares.
  
  The only preact internals pracht touches are the `options` hooks in the
  dev-only hydration-mismatch warning, which is installed behind
  `import.meta.env.DEV` and degrades to silence if the hooks it taps are never
  called. The SSR precompiler's `jsxTemplate` / `jsxAttr` / `jsxEscape` helpers
  are still exported from `preact/jsx-runtime` in 11. CI still runs against
  preact 10 — 11 is permitted, not yet verified.

## 0.1.1

### Patch Changes

- [#244](https://github.com/JoviDeCroock/pracht/pull/244) [`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop whole-object `import.meta.env` reads from inlining non-public env values
  into client bundles.

  Vite only replaces single-key `import.meta.env.KEY` accesses with their value.
  Every other read — a bare reference, destructuring, a spread, or bracket
  access — is replaced by an object literal holding all exposed variables,
  including the `VITE_`-prefixed ones Pracht does not treat as public. Because
  that leaves no accessor text behind, the name-based env leak scan could not see
  those values in the output.

  - `publicEnv` now reads a `PRACHT_PUBLIC_`-only snapshot injected by the pracht
    Vite plugin instead of enumerating `import.meta.env`, so builds inline public
    values only. Dev and non-Vite (plain Node, tests) behaviour is unchanged.
  - `@pracht/image` reads `import.meta.env?.MODE` / `?.DEV` directly for its dev
    warnings instead of pulling in the whole env object.
  - Env leak detection (`pracht build` and `pracht verify`) now reports
    whole-object `import.meta.env` reads in first-party client code, and also
    matches optional-chained accesses such as `import.meta.env?.VITE_SECRET`,
    which Vite replaces exactly like dot access but the scan previously ignored.
    Allowlist a deliberate whole-object read with
    `pracht({ envSafety: { allow: ["*"] } })`.

- [#243](https://github.com/JoviDeCroock/pracht/pull/243) [`21b192b`](https://github.com/JoviDeCroock/pracht/commit/21b192b8ce521e13249116c26b1d7b5298d4a59c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Require an explicit trusted `localOrigin` for relative image optimization sources so forged loopback or metadata-service Host headers cannot trigger server-side requests.

## 0.1.0

### Minor Changes

- [#192](https://github.com/JoviDeCroock/pracht/pull/192) [`5f3785e`](https://github.com/JoviDeCroock/pracht/commit/5f3785e84848d235a8e24d915e1ff0701d93369f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - New package: `@pracht/image` — next/image-quality image handling for pracht
  apps. Ships a responsive, CLS-safe `<Image>` Preact component (required
  `width`/`height` or `fill`, `srcset` across configurable device-size
  breakpoints, lazy + async decoding by default, `priority` for above-the-fold
  images) that renders plain `<img>` markup with zero client runtime. Image URLs
  are produced by pluggable loaders (`defaultLoader`, `cloudflareLoader`,
  `vercelLoader`, `passthroughLoader`) configured globally via
  `configureImage()` or per component via the `loader` prop. `@pracht/image/node`
  exports `createImageHandler()`, a sharp-backed optimization endpoint (sharp is
  an optional peer dependency) mounted as the `src/api/_pracht/image.ts` API
  route: it negotiates WebP/AVIF via `Accept`, only serves allowlisted widths,
  resolves relative sources against an explicit trusted production origin,
  restricts remote sources to `remotePatterns`, validates redirects before each
  hop, and stream-enforces the source image size cap before optimization. Answers
  with revalidated cache headers by default, supports GET plus HEAD API route
  exports, forwards Pracht's API abort signal to upstream fetches, and keeps
  development-only image dimension warnings out of production browser runtimes
  while preserving them in browser development builds. See docs/IMAGES.md.
