# Images

`@pracht/image` provides a responsive, CLS-safe `<Image>` component for Preact
apps plus pluggable optimization backends per deployment target. The design
mirrors next/image's loader pattern: the component decides *which* widths to
render, a loader decides *what URL* serves each width.

```bash
pnpm add @pracht/image
# For the built-in optimization endpoint (Node runtimes):
pnpm add sharp
```

## `<Image>`

```tsx
import { Image } from "@pracht/image";

<Image
  src="/banner.jpg"
  alt="Pracht banner"
  width={1200}
  height={280}
  sizes="(max-width: 1200px) 100vw, 1200px"
  priority
/>;
```

The component renders a plain `<img>` — it is SSR-safe, needs no hydration,
and ships zero client runtime beyond the component itself.

- **`src`** (required) — a path (`/banner.jpg`) or absolute URL, passed to the
  loader.
- **`alt`** (required) — use `alt=""` for decorative images.
- **`width` / `height`** (required unless `fill`) — intrinsic dimensions so
  the browser reserves space and avoids layout shift. In dev, missing
  dimensions log a `console.error`.
- **`fill`** — stretch to the nearest positioned ancestor instead
  (`position: absolute; inset: 0`), matching next/image ergonomics. Combine
  with `style={{ objectFit: "cover" }}` as needed. Defaults `sizes` to
  `100vw`.
- **`sizes`** — standard `sizes` attribute. When present (or in `fill` mode)
  the srcset uses `w` descriptors across the device-size breakpoints;
  otherwise a fixed image gets `1x`/`2x` candidates snapped to the breakpoint
  list so caches stay small.
- **`quality`** — loader quality hint, default `75`.
- **`placeholder`** — `"blur"` paints a tiny inline preview behind the image
  while it loads (see below). Defaults to `"empty"`.
- **`blurDataURL`** — the `data:image/…` URI used by `placeholder="blur"`.
  Supplied automatically when `src` is a `?pracht` import.
- **`priority`** — for above-the-fold images: switches the default
  `loading="lazy"` + `decoding="async"` to `loading="eager"` +
  `fetchpriority="high"`.
- **`loader`** — per-component loader override.

## Build-time imports (`?pracht`)

`@pracht/image/vite` exports `prachtImage()`, a Vite plugin that turns image
imports carrying the `?pracht` query into typed metadata modules:

```ts
// vite.config.ts — opt-in: the main pracht() plugin does NOT include it.
import { prachtImage } from "@pracht/image/vite";

export default {
  plugins: [pracht({ /* … */ }), prachtImage()],
};
```

```tsx
import hero from "./hero.jpg?pracht";
// hero: { src, width, height, blurDataURL }

<Image src={hero} alt="Hero" placeholder="blur" />;
```

- **`src`** goes through Vite's normal asset pipeline: source-directory
  imports get hashed file names, while root-relative imports from `publicDir`
  keep their stable public names; `base` and dev serving behave exactly like
  the corresponding plain asset import.
- **`width`/`height`** come from sharp metadata with EXIF orientation applied
  (a portrait photo whose raster is stored rotated reports its *display*
  dimensions), so `<Image src={hero}>` gets intrinsic sizing — and no layout
  shift — without repeating dimensions by hand.
- **`blurDataURL`** is a tiny (8px-wide) WebP data URI generated at build
  time. SVG imports skip it (vectors scale cleanly) but still provide
  dimensions; animated GIFs blur their first frame; CMYK JPEGs convert to
  sRGB.
- sharp is required at build time (it stays an optional peer dependency; the
  plugin fails with an install hint when missing). It never ships to any
  runtime bundle.
- In dev the same transform runs on demand and re-runs when the image file
  changes on disk.

For TypeScript, reference the shipped module declaration once (any `.d.ts`
in your app, or `"types": ["@pracht/image/client"]` in tsconfig):

```ts
/// <reference types="@pracht/image/client" />
```

## Blur placeholders

`placeholder="blur"` renders the `blurDataURL` as a CSS `background-image`
on the `<img>` itself (`background-size: cover`). This is deliberately
CSS-only:

- It is SSR-safe and needs **zero hydration** — `<Image>` stays a
  zero-runtime component and works with `hydration: "none"`. The real image
  simply covers the background as soon as it paints.
- No inline `on*` handlers are used (a JS `onload` fade would conflict with
  strict CSP setups), so there is no fade-out step; the swap is instant.
- **CSP:** the placeholder is an inline `style` attribute (as is `fill`), and
  style attributes are blocked by a policy whose `style-src` (or
  `style-src-attr`) lacks `'unsafe-inline'` — nonces and hashes do not apply
  to attributes. Under such a policy the image still renders; only the
  placeholder (and `fill` positioning) is silently dropped. Allow it with
  `style-src-attr 'unsafe-inline'` (scoped to attributes; safer than
  loosening `style-src` wholesale) and keep `img-src` including `data:` so
  the browser may load the inline WebP. See `docs/CSP.md`.
- Images with transparency show the placeholder through transparent regions —
  use `placeholder="empty"` (the default) for those.

`blurDataURL` can also be hand-provided (e.g. precomputed in a CMS). Values
are validated as well-formed `data:image/…` URIs before being interpolated
into the style attribute; anything else is ignored (with a dev warning), so a
hostile value cannot inject CSS. In dev, `placeholder="blur"` without any
`blurDataURL` logs a warning and renders without a placeholder.

## Loaders

A loader is `({ src, width, quality }) => string`.

| Loader | URL shape | Use with |
| --- | --- | --- |
| `defaultLoader` | `/api/_pracht/image?url=…&w=…&q=…` | the built-in endpoint below |
| `cloudflareLoader` | `/cdn-cgi/image/width=…,quality=…,format=auto/<src>` | Cloudflare Image Resizing (zone feature must be enabled) |
| `vercelLoader` | `/_vercel/image?url=…&w=…&q=…` | Vercel Image Optimization (`images` config required; Vercel only serves widths in `images.sizes`) |
| `passthroughLoader` | `<src>` unchanged | static hosts without an image service (srcset is omitted) |

Configure globally once (e.g. at the top of `src/routes.ts`, so it applies on
the server and in the browser) and override per component when needed:

```ts
import { cloudflareLoader, configureImage } from "@pracht/image";

configureImage({
  loader: cloudflareLoader,
  // deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  // imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  // quality: 75,
});
```

`createDefaultLoader("/my/endpoint")` builds a default-style loader for a
custom endpoint path.

## The optimization endpoint

`@pracht/image/node` exports `createImageHandler()`, a Web
`Request`/`Response` handler that resizes and re-encodes images with
[sharp](https://sharp.pixelplumbing.com) — an **optional** peer dependency.
Install sharp in your app; without it the endpoint answers 500 with an
install hint.

Mount it as an API route — this is the least invasive wiring and works with
`pracht dev`, adapter-node, and any adapter with a Node-compatible runtime:

```ts
// src/api/_pracht/image.ts
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  // Required for relative sources in every environment — the endpoint answers
  // 500 ("Relative image sources require createImageHandler({ localOrigin })")
  // until it is set, including in dev. `PRACHT_ORIGIN` is your own variable,
  // not a framework one: set it to the app's public origin (in dev, the address
  // `pracht dev` prints). Use the same trusted value as
  // nodeAdapter({ canonicalOrigin }).
  localOrigin: process.env.PRACHT_ORIGIN,
  // remotePatterns: [{ protocol: "https", hostname: "images.example.com" }],
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

That file maps to `/api/_pracht/image`, which is exactly what
`defaultLoader` targets — no further configuration needed.

### Behavior

- Negotiates output format via the `Accept` header: WebP by default; pass
  `formats: ["image/avif", "image/webp"]` to opt in to AVIF (smaller, slower
  to encode). Falls back to PNG/JPEG for older clients.
- Responds with `Cache-Control: public, max-age=14400, must-revalidate` (keyed
  on the full query string), `Vary: Accept`, and
  `X-Content-Type-Options: nosniff`.
- Never enlarges beyond the source width.
- SVG and GIF pass through untouched; SVG additionally gets
  `Content-Disposition: attachment` so remote SVGs cannot run scripts
  same-origin.

### Security

- **Trusted local origin.** Relative `url` values resolve only against the
  explicitly configured `localOrigin`, so a forged request `Host` cannot turn
  the endpoint into an open proxy. This is required in development too; the
  handler never trusts the request origin, including loopback-looking origins.
  With adapter-node, use the same trusted value for
  `nodeAdapter({ canonicalOrigin })` and `createImageHandler({ localOrigin })`.
- **Remote allowlist.** `remotePatterns` allowlists specific hosts (exact
  hostname or `*.` suffix wildcard, optional protocol/port/path prefix).
  Redirects use manual handling and every destination is validated before the
  next request is sent.
- **Width allowlist.** Only widths from the default breakpoint lists are
  served (reject otherwise), so callers cannot fill your cache with arbitrary
  variants. Pass `allowedWidths` when you customize `deviceSizes`/
  `imageSizes` via `configureImage()`, and `maxWidth` (default 3840) caps
  everything.
- Source responses must be `image/*` and are capped at 25 MiB
  (`maxSourceBytes`).

### Options

```ts
createImageHandler({
  localOrigin: "https://app.example.com",
  remotePatterns: [{ protocol: "https", hostname: "*.example.com", pathname: "/uploads" }],
  allowedWidths: [640, 1280],
  maxWidth: 3840,
  formats: ["image/avif", "image/webp"],
  cacheControl: "public, max-age=14400, must-revalidate",
  maxSourceBytes: 25 * 1024 * 1024,
  maxRedirects: 3,
});
```

Use an immutable one-year `cacheControl` only when every source URL is
content-addressed or otherwise guaranteed never to change.

Custom `fetchImage(url, request, signal)` hooks receive the Pracht API route
abort signal so upstream fetches can stop when the request times out or is
cancelled.

## Per-target guidance

- **adapter-node** — set one trusted origin on both the Node adapter and image
  handler in development and production, then put a CDN in front of the
  cacheable endpoint.
- **adapter-cloudflare** — prefer `configureImage({ loader: cloudflareLoader })`;
  Cloudflare Image Resizing handles resizing at the edge and the endpoint is
  not needed (sharp does not run on Workers).
- **adapter-vercel** — prefer `configureImage({ loader: vercelLoader })` with
  an `images` section in your Vercel project config; keep `images.sizes` in
  sync with your device sizes.
- **Static hosts** — use `passthroughLoader`.
- **`pracht dev`** — API routes are served by the dev server, so set
  `PRACHT_ORIGIN` to its exact origin (for example,
  `http://localhost:3000`) and install sharp. Platform loaders
  (`cloudflareLoader`, `vercelLoader`) generate URLs that only resolve on the
  deployed platform; if you want dev previews with those, pass
  `loader: passthroughLoader` conditionally (e.g. based on
  `import.meta.env.DEV`).

## Example

See `examples/basic`: `src/api/_pracht/image.ts` mounts the endpoint,
`src/routes/gallery.tsx` renders priority, fixed, `fill`, and
`?pracht`-imported blur-placeholder images, and `vite.config.ts` registers
`prachtImage()`.

## Not yet (follow-ups)

- Build-time generation of the resized variants themselves (today `?pracht`
  imports emit the hashed original plus metadata/blur; resizing still happens
  in the optimization endpoint or platform service at request time).
