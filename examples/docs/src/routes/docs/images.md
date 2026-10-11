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

The package has three entries: `@pracht/image` (the component and loaders), `@pracht/image/node` (the optimization endpoint), and `@pracht/image/vite` (build-time image imports).

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

The component renders plain `<img>` markup with no client runtime. Images default to `loading="lazy"` and `decoding="async"`. Use `priority` for above-the-fold images: it loads eagerly with `fetchpriority="high"`.

Always provide meaningful `alt` text, or `alt=""` for decorative images.

### Without the component

`getImageProps()` returns the same `<img>` attributes as a plain object:

```ts
import { getImageProps } from "@pracht/image";

const props = getImageProps({ src: "/banner.jpg", alt: "", width: 1200, height: 280 });
// → { src, srcset, sizes, width, height, loading, decoding, style, ... }
```

Use it when you emit HTML rather than Preact, such as a Markdown compiler, a
static template, or an email. `@pracht/markdown` uses it this way.

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

`fill` images stretch with `position: absolute; inset: 0`, so give the parent a stable height or aspect ratio.

---

## Build-Time Imports

Markdown routes use the same pipeline automatically for relative source images:

![A sunset optimized by the Pracht Markdown pipeline.](./markdown-image.jpg "Pracht Markdown image dogfood")

The source file sits beside this Markdown page. The build emits
content-hashed WebP candidates with intrinsic dimensions and a `srcset`.
Root-relative `public/` images are left untouched.

To import images with the `?pracht` query, add `prachtImage()` from `@pracht/image/vite`. The main `pracht()` plugin does not include it:

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

Passing the metadata object as `src` sets `width` and `height` for you, so there is no layout shift. The fields:

- `src` is a regular Vite asset URL: hashed in production for source-directory imports, stable for `publicDir` imports, and `base`-aware.
- `width` and `height` come from `sharp` with EXIF orientation applied, so rotated photos report their display size.
- `blurDataURL` is a tiny (8px wide) inline WebP used by `placeholder="blur"`.
- `variants` (static imports only) supplies content-hashed WebP candidates to the `srcset`.

`sharp` is needed at build time only (`pnpm add -D sharp`), so this works on Cloudflare and Vercel too. SVG imports get dimensions but no blur, and animated GIFs blur their first frame.

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

The placeholder is CSS-only, so it works with `hydration: "none"`. The real image paints over it with no fade.

Images with transparency show the blur through transparent regions; keep the default `placeholder="empty"` for those.

Under a Content-Security-Policy, allow `style-src-attr 'unsafe-inline'` (or `'unsafe-inline'` in `style-src`) and `data:` in `img-src`. Otherwise the browser drops the blur and `fill` positioning, though the image still renders.

Invalid `blurDataURL` values are ignored. In dev, they log a warning, as does `placeholder="blur"` without a `blurDataURL`.

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

The endpoint runs in `pracht dev`, adapter-node, and Node-compatible runtimes. It returns cacheable responses that vary on `Accept` and negotiates modern formats such as WebP.

Set `localOrigin` in every environment, to the same trusted URL as `nodeAdapter({ canonicalOrigin })` (in development, for example, `http://localhost:3000`). Without it, relative sources fail; the request `Host` is never trusted. `PRACHT_ORIGIN` is your own variable, not one pracht sets.

---

## Configure Loaders

A loader turns `{ src, width, quality }` into a URL. Configure one globally when your platform serves image variants:

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
| `netlifyLoader` | Netlify Image CDN |
| `passthroughLoader` | Static hosts without an image service |

You can also pass a `loader` prop to a single `<Image>` when one image needs different handling.

### Netlify Image CDN

Configure `netlifyLoader` for deployment and use the original images during `pracht dev`:

```ts [src/routes.ts]
import { configureImage, netlifyLoader, passthroughLoader } from "@pracht/image";

configureImage({
  loader: import.meta.env.DEV ? passthroughLoader : netlifyLoader,
});
```

Deployed images use `/.netlify/images` with responsive widths and quality `75` by default. Netlify negotiates the format and caches the transformed images. No `sharp` endpoint is needed.

Local source files work without image-service configuration. For remote sources, add the allowed URL patterns to `netlify.toml`:

```toml [netlify.toml]
[images]
remote_images = ['https://images\.example\.com/.*']
```

See [Netlify Image CDN](https://docs.netlify.com/build/image-cdn/overview/) for configuration options.

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

Every redirect destination is checked against the same allowlist. The endpoint serves only the default breakpoint widths, so callers cannot fill your cache with arbitrary variants. Pass `allowedWidths` when you customize breakpoints with `configureImage()`.

---

## Platform Notes

| Target | Recommendation |
| ------ | -------------- |
| Node | Set the same trusted origin on `nodeAdapter({ canonicalOrigin })` and `createImageHandler({ localOrigin })`, then use the default loader |
| Cloudflare Workers | Use `cloudflareLoader`; `sharp` does not run in Workers |
| Vercel | Use `vercelLoader` and keep Vercel image sizes aligned with your Pracht breakpoints |
| Netlify | Use `netlifyLoader` and configure `images.remote_images` for remote sources |
| Static hosting | Use `passthroughLoader` so images render without an optimization backend |

See the `examples/basic` gallery route for a complete endpoint, `?pracht` import, and blur-placeholder example.
