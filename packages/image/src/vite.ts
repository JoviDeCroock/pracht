import { readFile, stat } from "node:fs/promises";
import type { Plugin } from "vite";

import type { PrachtImageMetadata } from "./metadata.ts";

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

const PRACHT_IMAGE_QUERY = "pracht";
const DEFAULT_BLUR_WIDTH = 8;
const DEFAULT_BLUR_QUALITY = 70;

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

type SharpFactory = (input: Uint8Array) => SharpPipeline;

function createSharpImporter(load: () => Promise<unknown>): () => Promise<SharpFactory> {
  let cached: Promise<SharpFactory> | undefined;
  return () => {
    cached ??= load().then(
      (mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory,
      () => {
        cached = undefined;
        throw new Error(SHARP_INSTALL_HINT);
      },
    );
    return cached;
  };
}

/** `/path/to/hero.jpg?pracht` → true; `?pracht` may combine with other params. */
export function isPrachtImageId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;
  return id
    .slice(queryStart + 1)
    .split("&")
    .some((part) => part === PRACHT_IMAGE_QUERY);
}

/** Strip the entire query, leaving the file path. */
export function stripImageQuery(id: string): string {
  const queryStart = id.indexOf("?");
  return queryStart === -1 ? id : id.slice(0, queryStart);
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

/**
 * Generate the virtual module for a `?pracht` import. The `?url` import
 * delegates the actual file to Vite's asset pipeline, so hashing, `base`,
 * and dev serving all behave exactly like a plain asset import. `no-inline`
 * opts out of `assetsInlineLimit`: without it, images under the limit
 * (default 4 KB) turn `src` into a `data:` URI, which breaks
 * optimization-endpoint loaders (`/api/_pracht/image?url=data%3A…` is not a
 * fetchable same-origin path) and double-ships the bytes next to
 * `blurDataURL`. The metadata contract promises a real, hashed asset URL.
 * Exported for tests.
 */
export function createImageModuleCode(
  filePath: string,
  analyzed: Omit<PrachtImageMetadata, "src">,
): string {
  // Vite ids always use forward slashes, including Windows drive paths
  // (`C:/…`). Normalize before embedding the path in the generated import.
  const assetId = `${filePath.replace(/\\/g, "/")}?url&no-inline`;
  return [
    `import src from ${JSON.stringify(assetId)};`,
    `export const width = ${JSON.stringify(analyzed.width)};`,
    `export const height = ${JSON.stringify(analyzed.height)};`,
    `export const blurDataURL = ${JSON.stringify(analyzed.blurDataURL)};`,
    "export { src };",
    "export default { src, width, height, blurDataURL };",
  ].join("\n");
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  code: Promise<string>;
}

/**
 * Vite plugin enabling build-time image imports:
 *
 * ```ts
 * // vite.config.ts — add it next to pracht(); it is not included by default.
 * import { prachtImage } from "@pracht/image/vite";
 * export default { plugins: [pracht({ … }), prachtImage()] };
 * ```
 *
 * ```tsx
 * import hero from "./hero.jpg?pracht";
 * <Image src={hero} alt="…" placeholder="blur" />;
 * ```
 *
 * The import yields `{ src, width, height, blurDataURL }`: `src` goes through
 * Vite's normal asset pipeline (hashed URLs, `base`, dev server), dimensions
 * come from sharp metadata with EXIF orientation applied, and `blurDataURL`
 * is a tiny inline WebP generated at build time. Add
 * `/// <reference types="@pracht/image/client" />` (or `"types":
 * ["@pracht/image/client"]` in tsconfig) so TypeScript understands the query.
 */
export function prachtImage(options: PrachtImageOptions = {}): Plugin {
  const blurWidth = options.blurWidth ?? DEFAULT_BLUR_WIDTH;
  const blurQuality = options.blurQuality ?? DEFAULT_BLUR_QUALITY;
  if (!Number.isInteger(blurWidth) || blurWidth < 1 || blurWidth > 64) {
    throw new Error("prachtImage({ blurWidth }) expects an integer between 1 and 64.");
  }
  if (!Number.isInteger(blurQuality) || blurQuality < 1 || blurQuality > 100) {
    throw new Error("prachtImage({ blurQuality }) expects an integer between 1 and 100.");
  }
  const importSharp = createSharpImporter(options.loadSharp ?? (() => import("sharp")));
  // Keyed by file path, invalidated by mtime+size so edits to the source
  // image are picked up in dev (Vite reloads the module, we re-transform)
  // and repeated builds/environments reuse the sharp work.
  const cache = new Map<string, CacheEntry>();

  async function transform(filePath: string): Promise<string> {
    const stats = await stat(filePath).catch(() => {
      throw new Error(`[pracht/image] Could not read "${filePath}" for a "?pracht" import.`);
    });

    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.code;
    }

    const code = (async () => {
      const [sharp, source] = await Promise.all([importSharp(), readFile(filePath)]);
      let analyzed: Omit<PrachtImageMetadata, "src">;
      try {
        analyzed = await analyzeImage(sharp, source, { blurWidth, blurQuality });
      } catch (error) {
        throw new Error(
          `[pracht/image] Failed to process "?pracht" import of "${filePath}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return createImageModuleCode(filePath, analyzed);
    })();
    // Drop failed transforms so a fixed image (or a later sharp install) is
    // retried instead of replaying a cached rejection.
    code.catch(() => cache.delete(filePath));

    cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, code });
    return code;
  }

  return {
    name: "pracht:image-imports",
    // Run before Vite's asset plugin, which would otherwise treat
    // `hero.jpg?pracht` as a plain asset URL import.
    enforce: "pre",
    async resolveId(source, importer) {
      if (!isPrachtImageId(source)) return null;
      // Resolve the underlying file with the query stripped so relative
      // paths and aliases work, then re-attach the query as the module id.
      const resolved = await this.resolve(stripImageQuery(source), importer, { skipSelf: true });
      if (!resolved) return null;
      return `${resolved.id}?${PRACHT_IMAGE_QUERY}`;
    },
    async load(id) {
      if (!isPrachtImageId(id)) return null;
      const filePath = stripImageQuery(id);
      // Watch the source file so dev rebuilds when the image itself changes.
      this.addWatchFile(filePath);
      return transform(filePath);
    },
  };
}
