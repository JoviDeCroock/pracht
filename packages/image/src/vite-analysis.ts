import type { PrachtImageMetadata } from "./metadata.ts";

const SHARP_INSTALL_HINT =
  '[pracht/image] "?pracht" image imports require the optional "sharp" dependency ' +
  'at build time. Install it in your app with "pnpm add -D sharp" ' +
  "(or npm install -D sharp / yarn add -D sharp).";

/** Minimal structural typing for the parts of sharp used at build time. */
interface SharpMetadata {
  format?: string;
  width?: number;
  height?: number;
  orientation?: number;
  pages?: number;
}

interface SharpPipeline {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpPipeline;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

export type SharpFactory = (input: Uint8Array) => SharpPipeline;

export function createSharpImporter(load: () => Promise<unknown>): () => Promise<SharpFactory> {
  let cached: Promise<SharpFactory> | undefined;
  return () => {
    cached ??= load().then(
      (module) => ((module as { default?: unknown }).default ?? module) as SharpFactory,
      () => {
        cached = undefined;
        throw new Error(SHARP_INSTALL_HINT);
      },
    );
    return cached;
  };
}

/**
 * Read intrinsic dimensions (respecting EXIF orientation) and generate the
 * blur placeholder for one image buffer. Exported for tests.
 */
export async function analyzeImage(
  sharp: SharpFactory,
  source: Uint8Array,
  options: { blurWidth: number; blurQuality: number },
): Promise<Omit<PrachtImageMetadata, "src">> {
  const metadata = await sharp(source).metadata();

  let width = metadata.width;
  let height = metadata.height;
  // EXIF orientations 5-8 rotate the image by 90°: the raster dimensions are
  // swapped relative to how the image displays. Browsers honor the EXIF flag
  // (image-orientation: from-image is the default), so report display
  // dimensions or every `?pracht` portrait photo would reserve landscape space.
  const orientation = metadata.orientation ?? 1;
  if (orientation >= 5 && orientation <= 8) {
    width = metadata.height;
    height = metadata.width;
  }

  if (width == null || height == null || width <= 0 || height <= 0) {
    throw new Error(
      `could not determine intrinsic dimensions (format: ${metadata.format ?? "unknown"}). ` +
        "For SVG sources, add width/height or a viewBox attribute.",
    );
  }

  // SVG: vectors scale losslessly, so a raster blur placeholder would only
  // add bytes. Pass dimensions through and skip the blur.
  if (metadata.format === "svg") {
    return { width, height };
  }

  // Animated GIF/WebP: sharp reads the first frame by default, which is
  // exactly what a placeholder should show. `.rotate()` applies the EXIF
  // orientation so the blur matches how the full image displays.
  const blur = await sharp(source)
    .rotate()
    .resize({ width: options.blurWidth, withoutEnlargement: true })
    .webp({ quality: options.blurQuality })
    .toBuffer();

  return {
    width,
    height,
    blurDataURL: `data:image/webp;base64,${Buffer.from(blur).toString("base64")}`,
  };
}
