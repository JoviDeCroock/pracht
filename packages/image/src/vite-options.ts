/**
 * Options for the `?pracht` image import plugin.
 */
export interface PrachtImageOptions {
  /**
   * Width in pixels of the generated blur placeholder. Kept tiny on purpose:
   * the placeholder is inlined as a base64 data URI in HTML and JS.
   * Defaults to 8.
   */
  blurWidth?: number;
  /** WebP quality (1-100) of the blur placeholder. Defaults to 70. */
  blurQuality?: number;
  /** Override how sharp is imported (useful for tests). */
  loadSharp?: () => Promise<unknown>;
}

export interface ResolvedPrachtImageOptions {
  blurWidth: number;
  blurQuality: number;
  loadSharp: () => Promise<unknown>;
}

const DEFAULT_BLUR_WIDTH = 8;
const DEFAULT_BLUR_QUALITY = 70;

export function resolvePrachtImageOptions(options: PrachtImageOptions): ResolvedPrachtImageOptions {
  const blurWidth = options.blurWidth ?? DEFAULT_BLUR_WIDTH;
  const blurQuality = options.blurQuality ?? DEFAULT_BLUR_QUALITY;

  if (!Number.isInteger(blurWidth) || blurWidth < 1 || blurWidth > 64) {
    throw new Error("prachtImage({ blurWidth }) expects an integer between 1 and 64.");
  }
  if (!Number.isInteger(blurQuality) || blurQuality < 1 || blurQuality > 100) {
    throw new Error("prachtImage({ blurQuality }) expects an integer between 1 and 100.");
  }

  return {
    blurWidth,
    blurQuality,
    loadSharp: options.loadSharp ?? (() => import("sharp")),
  };
}
