---
title: Images
lead: Use `@pracht/image` for responsive image markup, reserved layout space, and deployment-specific optimization loaders.
breadcrumb: Images
prev:
  href: /docs/fonts
  title: Fonts
next:
  href: /docs/env
  title: Environment Variables
---

## Install

```sh
pnpm add @pracht/image

# Only needed for the built-in Node optimization endpoint or `?pracht` imports.
pnpm add sharp
```

`@pracht/image` is split into a framework-agnostic component entry (`@pracht/image`), a Node endpoint entry (`@pracht/image/node`), and a Vite plugin for build-time image imports (`@pracht/image/vite`).

---

## Render an Image

```tsx [src/routes/gallery.tsx]
import { Image } from "@pracht/image";

export function Component() {
  return (
    <Image
      src="/banner.jpg"
      alt="Pracht banner"
      width={1200}
      height={280}
      sizes="(max-width: 1200px) 100vw, 1200px"
      priority
    />
  );
}
```

The component renders plain `<img>` markup, so it works during SSR and SSG without adding client runtime. `loading="lazy"` and `decoding="async"` are the defaults. Use `priority` for above-the-fold images; it switches the image to eager loading and adds `fetchpriority="high"`.

Always provide meaningful `alt` text, or `alt=""` for decorative images.

### Without the component

`getImageProps()` resolves the same `<img>` attributes and returns them as a
plain object. `<Image>` is a one-line wrapper around it:

```ts
import { getImageProps } from "@pracht/image";

const props = getImageProps({ src: "/banner.jpg", alt: "", width: 1200, height: 280 });
// → { src, srcset, sizes, width, height, loading, decoding, style, ... }
```

Reach for it when you are emitting HTML rather than Preact — a Markdown
compiler, a static template, an email — and want identical sizing, loader,
placeholder, and priority behaviour without mounting a second renderer.
`@pracht/markdown` uses it for exactly that.

---

## Reserve Layout Space

Images need either intrinsic dimensions or `fill`:

```tsx
<Image src="/card.jpg" alt="Product preview" width={640} height={360} />
```

For background-style images, use `fill` inside a positioned parent:

```tsx
<div style={{ position: "relative", height: "18rem" }}>
  <Image
    src="/hero.jpg"
    alt="Pracht docs hero"
    fill
    sizes="100vw"
    style={{ objectFit: "cover" }}
  />
</div>
```

`fill` images stretch with `position: absolute; inset: 0`. The parent controls the rendered size, so give the parent a stable height or aspect ratio.

---

## Build-Time Imports

Markdown routes use the same pipeline automatically for relative source images:

![A sunset optimized by the Pracht Markdown pipeline.](./markdown-image.jpg "Pracht Markdown image dogfood")

The source file lives beside this Markdown page. The build emits cached,
content-hashed WebP candidates, adds intrinsic dimensions and responsive
`srcset` markup, and leaves root-relative `public/` images untouched.

Add `prachtImage()` from `@pracht/image/vite` to your Vite config to import images with the `?pracht` query. It is opt-in — the main `pracht()` plugin does not include it:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { prachtImage } from "@pracht/image/vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [prachtImage(), pracht({ /* … */ })],
});
```

A `?pracht` import yields typed metadata instead of a bare URL:

```tsx [src/routes/gallery.tsx]
import { Image } from "@pracht/image";
import hero from "../assets/hero.jpg?pracht";
// hero: { src, width, height, blurDataURL }

export function Component() {
  return <Image src={hero} alt="Sunset over water" placeholder="blur" />;
}
```

Add `&pracht-static` to emit responsive WebP files at build time instead of
using a runtime image service:

```tsx
import hero from "../assets/hero.jpg?pracht&pracht-static";

<Image src={hero} alt="Sunset over water" sizes="100vw" />;
```

Passing the metadata object as `src` gives the image intrinsic `width`/`height` automatically — no layout shift, no hand-maintained dimensions. The pieces:

- `src` goes through Vite's regular asset pipeline: source-directory imports get hashed file names in production, root-relative imports from `publicDir` keep their stable public names, and both get `base`-aware URLs plus normal dev serving.
- `width` and `height` come from `sharp` metadata with EXIF orientation applied, so rotated photos report their display dimensions.
- `blurDataURL` is a tiny (8px wide) inline WebP generated at build time, used by `placeholder="blur"`.
- `variants` is present on static imports and supplies content-hashed WebP candidates directly to the rendered `srcset`.

`sharp` must be installed at build time (`pnpm add -D sharp`); it never ships to a runtime bundle, so this works for Cloudflare and Vercel targets too. SVG imports provide dimensions but skip the blur (vectors scale cleanly), animated GIFs blur their first frame, and editing the source image invalidates the transform in dev.

For TypeScript, reference the shipped declaration for the `?pracht` query once, in any `.d.ts` file in your app:

```ts [src/images.d.ts]
/// <reference types="@pracht/image/client" />
```

---

## Blur Placeholders

`placeholder="blur"` paints the `blurDataURL` behind the image as a CSS `background-image` while the real file loads:

```tsx
<Image src={hero} alt="Sunset over water" placeholder="blur" />

// Or hand-provide the data URI for images that are not build-time imports:
<Image
  src="/uploads/photo.jpg"
  alt="Uploaded photo"
  width={1200}
  height={800}
  placeholder="blur"
  blurDataURL="data:image/webp;base64,…"
/>
```

The placeholder is CSS-only on purpose: it needs no hydration (it works with `hydration: "none"`), uses no inline event handlers, and disappears the instant the browser paints the real image over it. Caveats: there is no fade-out animation; images with transparency show the placeholder through transparent regions — keep the default `placeholder="empty"` for those; and because the placeholder is an inline `style` attribute, a Content-Security-Policy needs `style-src-attr 'unsafe-inline'` (or `'unsafe-inline'` in `style-src`) plus `data:` in `img-src`, or the blur (and `fill` positioning, which uses the same mechanism) is silently dropped while the image itself still renders.

`blurDataURL` values are validated as well-formed `data:image/…` URIs before they are interpolated into the style attribute; invalid values are ignored with a dev warning. Using `placeholder="blur"` without any `blurDataURL` also warns in dev.

---

## Mount the Default Endpoint

The default loader points at `/api/_pracht/image`. Add an API route at that path to resize and encode same-origin source images with `sharp`:

```ts [src/api/_pracht/image.ts]
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  localOrigin: process.env.PRACHT_ORIGIN,
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

This endpoint works in `pracht dev`, adapter-node, and Node-compatible runtimes. Set `localOrigin` to the same trusted URL used by `nodeAdapter({ canonicalOrigin })` in every environment (for example, `http://localhost:3000` in local development). Relative sources fail closed when it is missing; the request `Host` is never trusted. The endpoint returns cacheable, revalidated responses, varies on `Accept`, and negotiates modern output formats such as WebP.

---

## Configure Loaders

Loaders turn `{ src, width, quality }` into a URL. Configure one globally when your deployment platform should serve image variants:

```ts [src/routes.ts]
import { cloudflareLoader, configureImage } from "@pracht/image";

configureImage({
  loader: cloudflareLoader,
  quality: 75,
});
```

| Loader | Best For |
| ------ | -------- |
| `defaultLoader` | The `/api/_pracht/image` endpoint |
| `cloudflareLoader` | Cloudflare Image Resizing |
| `vercelLoader` | Vercel Image Optimization |
| `passthroughLoader` | Static hosts without an image service |

You can also pass a `loader` prop to a single `<Image>` when one image needs different handling.

---

## Remote Images

The Node endpoint accepts same-origin URLs by default. Allow remote hosts explicitly:

```ts [src/api/_pracht/image.ts]
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  localOrigin: process.env.PRACHT_ORIGIN,
  remotePatterns: [
    { protocol: "https", hostname: "images.example.com", pathname: "/uploads" },
  ],
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

Every redirect destination is checked before it is requested. Widths are also restricted to configured breakpoints, which keeps attackers from filling your cache with arbitrary image variants.

---

## Platform Notes

| Target | Recommendation |
| ------ | -------------- |
| Node | Set the same trusted origin on `nodeAdapter({ canonicalOrigin })` and `createImageHandler({ localOrigin })`, then use the default loader |
| Cloudflare Workers | Use `cloudflareLoader`; `sharp` does not run in Workers |
| Vercel | Use `vercelLoader` and keep Vercel image sizes aligned with your Pracht breakpoints |
| Static hosting | Use `passthroughLoader` so images render without an optimization backend |

See the `examples/basic` gallery route for a complete endpoint, `?pracht` import, and blur-placeholder example.
