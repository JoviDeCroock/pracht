# @pracht/image

Responsive, CLS-safe `<Image>` component for [pracht](https://github.com/JoviDeCroock/pracht)
apps with pluggable optimization backends per deployment target, mirroring
next/image's loader pattern.

- Plain `<img>` markup: SSR-safe, no hydration, zero client runtime.
- Required `width`/`height` (or `fill`) to prevent layout shift, with dev
  warnings when missing.
- `srcset` across configurable device-size breakpoints, `sizes` support,
  `loading="lazy"` + `decoding="async"` by default, `priority` for
  above-the-fold images.
- Loaders for the built-in endpoint, Cloudflare Image Resizing, Vercel Image
  Optimization, or plain passthrough.
- A Node optimization endpoint (`@pracht/image/node`) backed by
  [sharp](https://sharp.pixelplumbing.com) (optional peer dependency) with a
  trusted-local-origin/remote-allowlist security model and revalidated cache
  headers.
- Build-time `?pracht` image imports (`@pracht/image/vite`): hashed asset URL,
  intrinsic dimensions (EXIF-orientation aware), and a tiny inline
  `blurDataURL` for CSS-only `placeholder="blur"`.

```bash
pnpm add @pracht/image
pnpm add sharp # only needed for the built-in endpoint and ?pracht imports
```

```tsx
import { Image } from "@pracht/image";

<Image src="/banner.jpg" alt="Banner" width={1200} height={280} priority />;
```

```tsx
// vite.config.ts: plugins: [pracht({ … }), prachtImage()] (from "@pracht/image/vite")
import hero from "./hero.jpg?pracht"; // { src, width, height, blurDataURL }

<Image src={hero} alt="Hero" placeholder="blur" />;
```

```ts
// src/api/_pracht/image.ts — mounts the optimization endpoint
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  localOrigin: process.env.PRACHT_ORIGIN,
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

Set `localOrigin` to the same trusted origin used by
`nodeAdapter({ canonicalOrigin })` in development and production. Relative
sources fail closed when it is omitted; request and Host-derived origins are
never trusted, even when they look like loopback addresses.

See [docs/IMAGES.md](https://github.com/JoviDeCroock/pracht/blob/main/docs/IMAGES.md)
for the full guide: loader configuration, endpoint security options, and
per-adapter guidance.
