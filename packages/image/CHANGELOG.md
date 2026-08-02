# @pracht/image

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
