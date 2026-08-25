---
name: add-images
version: 1.0.0
description: |
  Wire `@pracht/image` into a pracht app: the CLS-safe zero-runtime `<Image>`
  component, the right loader for the deployment target (built-in sharp
  endpoint, Cloudflare Image Resizing, Vercel Image Optimization, or
  passthrough), build-time `?pracht` imports with blur placeholders, prebuilt
  static WebP variants, and the security settings the optimization endpoint
  needs.
  Use when asked to "add images", "optimize images", "responsive images",
  "set up next/image equivalent", "enable Cloudflare image resizing", "add blur
  placeholders", or "my images cause layout shift".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Images

`@pracht/image` splits the problem the way next/image does: the `<Image>`
component decides *which widths* to render, a loader decides *what URL* serves
each width (`docs/IMAGES.md`). The component renders a plain `<img>` — SSR-safe,
zero hydration, works with `hydration: "none"`.

## Step 1: Choose the backend for the deployment target

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_build`, `doctor`, `verify`) over shelling out.

```bash
pracht inspect build --json   # adapterTarget (requires a prior `pracht build`)
```

| Target | Loader | Notes |
| ------ | ------ | ----- |
| Node | `defaultLoader` + the built-in endpoint | needs `sharp`; put a CDN in front |
| Cloudflare | `cloudflareLoader` | Image Resizing must be enabled on the zone; sharp does not run on Workers |
| Vercel | `vercelLoader` | needs an `images` section in the project config; Vercel only serves widths listed in `images.sizes` |
| Static host | `passthroughLoader` | no image service — srcset is omitted |
| Any target, no runtime service | `?pracht&pracht-static` imports | prebuilt WebP variants, no loader involved |

Confirm the choice with `AskUserQuestion` when the app deploys to more than one
target — a per-target `configureImage()` behind an env flag is the usual answer
(`examples/basic` does exactly this).

## Step 2: Install

```bash
pnpm add @pracht/image
pnpm add sharp              # only for the built-in Node endpoint
pnpm add -D sharp           # only for `?pracht` imports / static variants
```

sharp stays an optional peer dependency; the vite plugin fails with an install
hint when a `?pracht` import needs it, and the endpoint answers 500 with the
same hint at runtime.

## Step 3: Configure the loader once

Put `configureImage()` where both the server and the browser evaluate it — the
top of `src/routes.ts` is the canonical spot:

```ts
import { cloudflareLoader, configureImage } from "@pracht/image";

configureImage({
  loader: cloudflareLoader,
  // deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  // imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  // quality: 75,
});
```

`createDefaultLoader("/my/endpoint")` builds a default-style loader for a custom
endpoint path. Root-absolute endpoints pick up Vite's deploy `base`
automatically; provider loaders (`cloudflareLoader`, `vercelLoader`)
deliberately stay at the origin root.

## Step 4: Render images

```tsx
import { Image } from "@pracht/image";

<Image
  src="/banner.jpg"
  alt="Product banner"
  width={1200}
  height={280}
  sizes="(max-width: 1200px) 100vw, 1200px"
  priority
/>;
```

- `alt` is required — use `alt=""` for decorative images.
- `width`/`height` are required unless `fill`; they reserve space and prevent
  layout shift. Missing dimensions log a `console.error` in dev.
- `sizes` (or `fill`) switches the srcset to `w` descriptors across
  `deviceSizes`; a fixed image gets `1x`/`2x` candidates snapped to the
  breakpoint list so caches stay small.
- `priority` on above-the-fold images swaps `loading="lazy"` +
  `decoding="async"` for `loading="eager"` + `fetchpriority="high"`. Use it for
  the LCP image only.
- `fill` positions the image absolutely inside the nearest positioned ancestor
  and defaults `sizes` to `100vw`; pair with `style={{ objectFit: "cover" }}`.

## Step 5: Build-time imports and static variants

Register the plugin — the main `pracht()` plugin does **not** include it:

```ts
// vite.config.ts
import { prachtImage } from "@pracht/image/vite";

export default { plugins: [prachtImage(), pracht({ /* … */ })] };
```

```tsx
import hero from "./hero.jpg?pracht";                 // { src, width, height, blurDataURL }
import banner from "./banner.jpg?pracht&pracht-static"; // + prebuilt WebP variants

<Image src={hero} alt="Hero" placeholder="blur" />;
<Image src={banner} alt="Banner" sizes="(max-width: 960px) 100vw, 960px" />;
```

- Dimensions come from sharp metadata with EXIF orientation applied, so a
  rotated portrait reports its *display* size.
- `blurDataURL` is an 8px WebP data URI generated at build time. SVGs skip it,
  animated GIFs blur their first frame.
- `pracht-static` emits content-hashed WebP files at `staticWidths`, takes
  precedence over the global loader, and is cached in Vite's `cacheDir` keyed by
  source bytes. It requires an **absolute** Vite `base`; SVG and animated
  sources pass through unchanged.
- Root-relative `publicDir` imports keep stable public URLs and bypass the
  runtime loader.
- Types: `"types": ["@pracht/image/client"]` in tsconfig, or a triple-slash
  reference in any `.d.ts`.

`@pracht/markdown` uses `?pracht&pracht-static` automatically for relative
Markdown images and renders them with `getImageProps()` — see `/add-content`.

## Step 6: Mount the optimization endpoint (Node-compatible runtimes only)

```ts
// src/api/_pracht/image.ts
import { createImageHandler } from "@pracht/image/node";

const imageHandler = createImageHandler({
  // Required in every environment, including dev. Your own env var, not a
  // framework one — set it to the app's public origin and use the same value
  // as nodeAdapter({ canonicalOrigin }).
  localOrigin: process.env.PRACHT_ORIGIN,
  // remotePatterns: [{ protocol: "https", hostname: "*.example.com", pathname: "/uploads" }],
  // allowedWidths: [640, 1280],   // required when configureImage() customizes the breakpoints
});

export const GET = imageHandler;
export const HEAD = imageHandler;
```

That file maps to `/api/_pracht/image`, exactly what `defaultLoader` targets —
no further configuration. The endpoint negotiates WebP via `Accept` (pass
`formats: ["image/avif", "image/webp"]` for AVIF), never enlarges beyond the
source, passes SVG/GIF through, and answers
`Cache-Control: public, max-age=14400, must-revalidate` with `Vary: Accept`.

## Step 7: Verify

```bash
pracht dev            # set PRACHT_ORIGIN to the exact origin it prints
pracht build
pracht verify --json
```

Check in the browser: the `<img>` carries `srcset`/`sizes`, the LCP image is
`fetchpriority="high"`, and no layout shift occurs on reload. Then run
`/audit-bundles` and `/audit-seo` if image work was part of a performance pass.

## Rules

1. Never leave `localOrigin` unset — relative sources are resolved only against
   it, so a forged `Host` cannot turn the endpoint into an open proxy. The
   handler answers 500 until it is configured, including in dev.
2. Always allowlist remote hosts with `remotePatterns`; never proxy arbitrary
   URLs.
3. When `configureImage()` customizes `deviceSizes`/`imageSizes`, pass the
   matching `allowedWidths` — the endpoint rejects widths outside its allowlist
   by design, and skipping this silently breaks the srcset.
4. Do not use `priority` on more than the one above-the-fold image per route.
5. `placeholder="blur"` writes an inline `style` attribute: a CSP without
   `style-src-attr 'unsafe-inline'` silently drops it (and `fill` positioning),
   and `img-src` must include `data:`. See `docs/CSP.md`.
6. Platform loaders generate URLs that only resolve on the deployed platform —
   fall back to `passthroughLoader` behind `import.meta.env.DEV` for local
   previews.
7. Use an immutable one-year `cacheControl` only when every source URL is
   content-addressed.
8. Never overwrite an existing `vite.config.ts`, image API route, or
   `configureImage()` call — diff first and confirm with `AskUserQuestion`.

$ARGUMENTS
