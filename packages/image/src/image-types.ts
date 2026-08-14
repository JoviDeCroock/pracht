import type { JSX } from "preact";

import type { ImageLoader } from "./loaders.ts";
import type { PrachtImageMetadata } from "./metadata.ts";

export interface ImageProps extends Omit<
  JSX.HTMLAttributes<HTMLImageElement>,
  | "src"
  | "srcset"
  | "srcSet"
  | "width"
  | "height"
  | "sizes"
  | "loading"
  | "alt"
  | "style"
  | "placeholder"
> {
  /**
   * Source path (`/hero.jpg`), absolute URL, or the metadata object from a
   * build-time `?pracht` import (which supplies `width`, `height`, and
   * `blurDataURL` automatically).
   */
  src: string | PrachtImageMetadata;
  /** Required for accessibility. Use `alt=""` for decorative images. */
  alt: string;
  /** Intrinsic width in pixels. Required unless `fill` is set. */
  width?: number | `${number}`;
  /** Intrinsic height in pixels. Required unless `fill` is set. */
  height?: number | `${number}`;
  /**
   * Stretch the image to fill its nearest positioned ancestor instead of
   * reserving intrinsic dimensions. Applies `position: absolute; inset: 0`.
   */
  fill?: boolean;
  /** Standard `sizes` attribute; switches the srcset to `w` descriptors. */
  sizes?: string;
  /** Quality hint forwarded to the loader (1-100). */
  quality?: number;
  /**
   * Mark as above-the-fold: loads eagerly with `fetchpriority="high"`.
   * Everything else defaults to `loading="lazy"` + `decoding="async"`.
   */
  priority?: boolean;
  loading?: "lazy" | "eager";
  /** Per-component loader override; falls back to the configured loader. */
  loader?: ImageLoader;
  /**
   * `"blur"` paints a tiny inline preview behind the image while it loads.
   * Requires a `blurDataURL` — supplied automatically when `src` is a
   * `?pracht` import, or pass it by hand. The placeholder is pure CSS
   * (a `background-image` on the `<img>` itself), so it needs no hydration
   * and works with `hydration: "none"`; the real image simply covers it once
   * it paints. Note: images with transparency show the placeholder through
   * transparent regions — prefer `placeholder="empty"` for those.
   */
  placeholder?: "blur" | "empty";
  /**
   * `data:image/…` URI painted behind the image when `placeholder="blur"`.
   * Values that are not well-formed image data URIs are ignored (they could
   * otherwise inject CSS via the style attribute).
   */
  blurDataURL?: string;
  style?: string | JSX.CSSProperties;
}
