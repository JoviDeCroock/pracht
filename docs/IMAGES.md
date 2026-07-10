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
- **`priority`** — for above-the-fold images: switches the default
  `loading="lazy"` + `decoding="async"` to `loading="eager"` +
  `fetchpriority="high"`.
- **`loader`** — per-component loader override.

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
- Responds with `Cache-Control: public, max-age=31536000, immutable` (keyed
  on the full query string), `Vary: Accept`, and
  `X-Content-Type-Options: nosniff`.
- Never enlarges beyond the source width.
- SVG and GIF pass through untouched; SVG additionally gets
  `Content-Disposition: attachment` so remote SVGs cannot run scripts
  same-origin.

### Security

- **Same-origin by default.** Only relative `url` values are accepted unless
  `remotePatterns` allowlists specific hosts (exact hostname or `*.` suffix
  wildcard, optional protocol/port/path prefix). Redirects are re-validated
  against the same allowlist.
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
  remotePatterns: [{ protocol: "https", hostname: "*.example.com", pathname: "/uploads" }],
  allowedWidths: [640, 1280],
  maxWidth: 3840,
  formats: ["image/avif", "image/webp"],
  cacheControl: "public, max-age=31536000, immutable",
  maxSourceBytes: 25 * 1024 * 1024,
});
```

Custom `fetchImage(url, request, signal)` hooks receive the Pracht API route
abort signal so upstream fetches can stop when the request times out or is
cancelled.

## Per-target guidance

- **adapter-node** — mount the API route as above; done. Put a CDN in front
  and the immutable cache headers do the rest.
- **adapter-cloudflare** — prefer `configureImage({ loader: cloudflareLoader })`;
  Cloudflare Image Resizing handles resizing at the edge and the endpoint is
  not needed (sharp does not run on Workers).
- **adapter-vercel** — prefer `configureImage({ loader: vercelLoader })` with
  an `images` section in your Vercel project config; keep `images.sizes` in
  sync with your device sizes.
- **Static hosts** — use `passthroughLoader`.
- **`pracht dev`** — API routes are served by the dev server, so the endpoint
  works in dev exactly like in production (sharp required). Platform loaders
  (`cloudflareLoader`, `vercelLoader`) generate URLs that only resolve on the
  deployed platform; if you want dev previews with those, pass
  `loader: passthroughLoader` conditionally (e.g. based on
  `import.meta.env.DEV`).

## Example

See `examples/basic`: `src/api/_pracht/image.ts` mounts the endpoint and
`src/routes/gallery.tsx` renders priority, fixed, and `fill` images.

## Not yet (follow-ups)

- Build-time optimization of images referenced by SSG pages.
- Blur placeholders (`placeholder="blur"`).
