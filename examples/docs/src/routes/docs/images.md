---
title: Images
lead: Use <code>@pracht/image</code> for responsive image markup, reserved layout space, and deployment-specific optimization loaders.
breadcrumb: Images
prev:
  href: /docs/styling
  title: Styling
next:
  href: /docs/cli
  title: CLI
---

## Install

```sh
pnpm add @pracht/image

# Only needed when you use the built-in Node optimization endpoint.
pnpm add sharp
```

`@pracht/image` is split into a framework-agnostic component entry and a Node endpoint entry. Import the component from `@pracht/image`; import the optimization handler from `@pracht/image/node`.

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

## Mount the Default Endpoint

The default loader points at `/api/_pracht/image`. Add an API route at that path to resize and encode same-origin source images with `sharp`:

```ts [src/api/_pracht/image.ts]
import { createImageHandler } from "@pracht/image/node";

export const GET = createImageHandler();
```

This endpoint works in `pracht dev`, adapter-node, and Node-compatible runtimes. It returns immutable cache headers, varies on `Accept`, and negotiates modern output formats such as WebP.

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

export const GET = createImageHandler({
  remotePatterns: [
    { protocol: "https", hostname: "images.example.com", pathname: "/uploads" },
  ],
});
```

Remote allowlists are rechecked after redirects. Widths are also restricted to configured breakpoints, which keeps attackers from filling your cache with arbitrary image variants.

---

## Platform Notes

| Target | Recommendation |
| ------ | -------------- |
| Node | Mount `createImageHandler()` and use the default loader |
| Cloudflare Workers | Use `cloudflareLoader`; `sharp` does not run in Workers |
| Vercel | Use `vercelLoader` and keep Vercel image sizes aligned with your Pracht breakpoints |
| Static hosting | Use `passthroughLoader` so images render without an optimization backend |

See the `examples/basic` gallery route for a complete endpoint plus component example.
