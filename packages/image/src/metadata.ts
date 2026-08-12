/**
 * Metadata produced by a build-time `?pracht` image import (see
 * `prachtImage()` from `@pracht/image/vite`).
 *
 * ```ts
 * import hero from "./hero.jpg?pracht";
 * // hero: { src, width, height, blurDataURL }
 * ```
 *
 * Pass the whole object to `<Image src={hero} …>` to get intrinsic sizing and
 * `placeholder="blur"` support without repeating dimensions by hand.
 */
export interface PrachtImageMetadata {
  /** Final asset URL (hashed in production builds, dev-served in dev). */
  src: string;
  /** Intrinsic width in pixels, after applying EXIF orientation. */
  width: number;
  /** Intrinsic height in pixels, after applying EXIF orientation. */
  height: number;
  /**
   * Tiny inline preview (`data:image/webp;base64,…`, ~8px wide) for
   * `placeholder="blur"`. Undefined for SVG sources: vectors scale cleanly,
   * so a raster blur adds bytes without adding information.
   */
  blurDataURL?: string;
}
