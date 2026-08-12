---
"@pracht/image": minor
---

Add build-time image imports and blur placeholders.

- New `@pracht/image/vite` entry exports `prachtImage()`, an opt-in Vite
  plugin that turns `import hero from "./hero.jpg?pracht"` into typed
  metadata `{ src, width, height, blurDataURL }`. The file goes through
  Vite's normal asset pipeline (hashed URLs, `base`, dev serving), the
  dimensions come from sharp metadata with EXIF orientation applied, and
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
