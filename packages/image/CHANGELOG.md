# @pracht/image

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
