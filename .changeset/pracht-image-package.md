---
"@pracht/image": minor
---

New package: `@pracht/image` — next/image-quality image handling for pracht
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
restricts sources to same-origin unless `remotePatterns` opts hosts in, and
stream-enforces the source image size cap before optimization. Answers with
immutable cache headers and supports GET plus HEAD API route exports. See
docs/IMAGES.md.
