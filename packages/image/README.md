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
  same-origin/allowlist security model and immutable cache headers.

```bash
pnpm add @pracht/image
pnpm add sharp # only needed for the built-in endpoint
```

```tsx
import { Image } from "@pracht/image";

<Image src="/banner.jpg" alt="Banner" width={1200} height={280} priority />;
```

```ts
// src/api/_pracht/image.ts — mounts the optimization endpoint
import { createImageHandler } from "@pracht/image/node";

export const GET = createImageHandler();
```

See [docs/IMAGES.md](https://github.com/JoviDeCroock/pracht/blob/main/docs/IMAGES.md)
for the full guide: loader configuration, endpoint security options, and
per-adapter guidance.
