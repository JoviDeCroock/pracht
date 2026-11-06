---
title: Images
lead: "Render responsive images with `@pracht/image`: reserved layout space, build-time imports, and an optimization loader for each host."
---

## Install

```sh
pnpm add @pracht/image

# Only needed for the built-in Node optimization endpoint or `?pracht` imports.
pnpm add sharp
```

| Entry | Contents |
| ----- | -------- |
| `@pracht/image` | `<Image>`, `getImageProps()`, `configureImage()`, loaders |
| `@pracht/image/node` | `createImageHandler()`, the optimization endpoint |
| `@pracht/image/vite` | `prachtImage()`, build-time `?pracht` imports |

## Render an image

```tsx [src/routes/gallery.tsx]
import { Image } from "@pracht/image";

export function Component() {
  return (
    <Image
      src="/banner.jpg"
      alt="pracht banner"
      width={1200}
      height={280}
      sizes="(max-width: 1200px) 100vw, 1200px"
      priority
    />
  );
}
```

The component renders plain `<img>` markup with no client runtime. Images default to `loading="lazy"` and `decoding="async"`. Set `priority` on above-the-fold images to load them eagerly with `fetchpriority="high"`.

Give every image meaningful `alt` text, or `alt=""` when it is decorative.

### Without the component

`getImageProps()` returns the same `<img>` attributes as a plain object:

```ts
import { getImageProps } from "@pracht/image";

const props = getImageProps({ src: "/banner.jpg", alt: "", width: 1200, height: 280 });
// → { src, srcset, sizes, width, height, loading, decoding, style, ... }
```

Use it when you emit HTML rather than Preact, such as from a Markdown compiler, a static template, or an email. `@pracht/markdown` uses it this way.

## Reserve layout space

Give every image intrinsic dimensions or `fill`:

```tsx
<Image src="/card.jpg" alt="Product preview" width={640} height={360} />
```

For background-style images, use `fill` inside a positioned parent:

```tsx
<div style={{ position: "relative", height: "18rem" }}>
  <Image
    src="/hero.jpg"
    alt="pracht docs hero"
    fill
    sizes="100vw"
    style={{ objectFit: "cover" }}
  />
</div>
```

`fill` images stretch with `position: absolute; inset: 0`, so give the parent a stable height or aspect ratio.

## Build-time imports

Markdown routes optimize relative source images automatically:

![A sunset optimized by the pracht Markdown pipeline.](./markdown-image.jpg "pracht Markdown image dogfood")

The source file sits beside this Markdown page, and the build emits content-hashed WebP candidates with intrinsic dimensions and a `srcset`. Root-relative `public/` images are left untouched.

To import images with the `?pracht` query in components, add `prachtImage()` from `@pracht/image/vite`. The main `pracht()` plugin does not include it:

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

Add `&pracht-static` to emit responsive WebP files at build time instead of using a runtime image service:

```tsx
import hero from "../assets/hero.jpg?pracht&pracht-static";

<Image src={hero} alt="Sunset over water" sizes="100vw" />;
```

Passing the metadata object as `src` sets `width` and `height`, so the image causes no layout shift. The fields:

| Field | Value |
| ----- | ----- |
| `src` | Vite asset URL: hashed in production for source-directory imports, stable for `publicDir` imports, `base`-aware |
| `width`, `height` | Display size read by `sharp`, with EXIF orientation applied |
| `blurDataURL` | 8px-wide inline WebP for `placeholder="blur"` |
| `variants` | Content-hashed WebP `srcset` candidates (`&pracht-static` only) |

`sharp` is needed at build time only (`pnpm add -D sharp`), so imports work on Cloudflare and Vercel too. SVG imports get dimensions but no blur; animated GIFs blur their first frame.

For TypeScript, reference the declaration for the `?pracht` query once, in any `.d.ts` file in your app:

```ts [src/images.d.ts]
/// <reference types="@pracht/image/client" />
```

## Blur placeholders

Set `placeholder="blur"` to paint `blurDataURL` behind the image as a CSS `background-image` while the file loads:

```tsx
<Image src={hero} alt="Sunset over water" placeholder="blur" />

// Or provide the data URI yourself for images that are not build-time imports:
<Image
  src="/uploads/photo.jpg"
  alt="Uploaded photo"
  width={1200}
  height={800}
  placeholder="blur"
  blurDataURL="data:image/webp;base64,…"
/>
```

The placeholder is CSS-only, so it works with `hydration: "none"`. The image paints over it with no fade. Images with transparency show the blur through transparent regions; keep the default `placeholder="empty"` for those.

Under a Content Security Policy, allow `style-src-attr 'unsafe-inline'` (or `'unsafe-inline'` in `style-src`) and `data:` in `img-src`. Otherwise the browser drops the blur and `fill` positioning, though the image still renders.

An invalid `blurDataURL` is ignored. In dev, it logs a warning, as does `placeholder="blur"` without a `blurDataURL`.

## Mount the default endpoint

The default loader points at `/api/_pracht/image`. Add an API route at that path to resize and encode same-origin images with `sharp`:

```ts [src/api/_pracht/image.ts]
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  localOrigin: process.env.PRACHT_ORIGIN,
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

The endpoint runs in `pracht dev`, `@pracht/adapter-node`, and Node-compatible runtimes. Responses are cacheable, vary on `Accept`, and use WebP when the browser accepts it.

Set `localOrigin` in every environment to the same trusted URL as `nodeAdapter({ canonicalOrigin })`, for example `http://localhost:3000` in development. Without it, relative sources fail, because the request `Host` is never trusted. `PRACHT_ORIGIN` is your own variable, not one pracht sets.

### Endpoint options

| Option | Default | Effect |
| ------ | ------- | ------ |
| `localOrigin` | none | Trusted origin for relative sources |
| `remotePatterns` | `[]` | Remote hosts to allow (see below) |
| `allowedWidths` | default breakpoints | Widths the endpoint produces; match it to `configureImage({ deviceSizes, imageSizes })` |
| `maxWidth` | `3840` | Upper bound on the requested width |
| `formats` | `["image/webp"]` | Formats negotiated from `Accept`; add `"image/avif"` to opt in |
| `cacheControl` | `public, max-age=14400, must-revalidate` | `Cache-Control` on successful responses |
| `sourceQueryParams` | `[]` | Query parameters kept on local image files, such as `["v"]` |
| `cache` | `{ maxBytes: 50 MiB, maxAge: 3600 }` | In-memory result cache; `false` turns it off |
| `maxConcurrency` | `4` | Images optimized at once |
| `maxSourceBytes` | 25 MiB | Largest source image accepted |
| `maxRedirects` | `3` | Redirects followed per source |
| `fetchImage` | `fetch` | Custom source fetcher; turns the memory cache off unless you set `cache` |

Local image files are fetched without their query string (`/hero.png?bust=1` becomes `/hero.png`) unless a parameter is listed in `sourceQueryParams`. Remote sources, and local sources without an image extension, keep their full URL.

Simultaneous requests for one image share a single encode. A cached result never outlives the lifetime in `cacheControl`, so `max-age=0` sends every request to the source. When 64 requests are waiting for a slot, new ones get a `503` with `Retry-After`.

## Configure loaders

A loader turns `{ src, width, quality }` into a URL. Configure one globally when your platform serves image variants:

```ts [src/routes.ts]
import { cloudflareLoader, configureImage } from "@pracht/image";

configureImage({
  loader: cloudflareLoader,
  quality: 75,
});
```

`configureImage()` also accepts `deviceSizes` and `imageSizes` to change the `srcset` breakpoints. Pass a `loader` prop to a single `<Image>` when one image needs different handling.

| Loader | Use for |
| ------ | ------- |
| `defaultLoader` | The `/api/_pracht/image` endpoint |
| `cloudflareLoader` | Cloudflare Image Resizing |
| `vercelLoader` | Vercel Image Optimization |
| `netlifyLoader` | Netlify Image CDN |
| `passthroughLoader` | Static hosts without an image service |

### Netlify Image CDN

Use `netlifyLoader` in deployments and the original images during `pracht dev`:

```ts [src/routes.ts]
import { configureImage, netlifyLoader, passthroughLoader } from "@pracht/image";

configureImage({
  loader: import.meta.env.DEV ? passthroughLoader : netlifyLoader,
});
```

Deployed images load from `/.netlify/images` with responsive widths and quality `75`. Netlify negotiates the format and caches the results, so no `sharp` endpoint is needed.

Local source files need no image-service configuration. For remote sources, list the allowed URL patterns in `netlify.toml`:

```toml [netlify.toml]
[images]
remote_images = ['https://images\.example\.com/.*']
```

See [Netlify Image CDN](https://docs.netlify.com/build/image-cdn/overview/) for the remaining options.

## Remote images

The Node endpoint accepts same-origin URLs only. Allow remote hosts with `remotePatterns`:

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

Every redirect destination is checked against the same allowlist.

## Platform notes

| Target | Setup |
| ------ | ----- |
| Node | Set the same trusted origin on `nodeAdapter({ canonicalOrigin })` and `createImageHandler({ localOrigin })`, then use the default loader |
| Cloudflare Workers | Use `cloudflareLoader`; `sharp` does not run in Workers |
| Vercel | Use `vercelLoader` and keep Vercel's `images.sizes` aligned with your breakpoints |
| Netlify | Use `netlifyLoader` and configure `images.remote_images` for remote sources |
| Static hosting | Use `passthroughLoader` so images render without an optimization backend |

The `examples/basic` gallery route shows a complete endpoint, `?pracht` import, and blur placeholder.
