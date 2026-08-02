import { DEFAULT_QUALITY, defaultLoader, type ImageLoader } from "./loaders.ts";

/**
 * Device-width breakpoints used for `srcset` candidates when an image is
 * responsive (`fill` or a `sizes` prop). Matches the next/image defaults.
 */
export const DEFAULT_DEVICE_SIZES: readonly number[] = [
  640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];

/**
 * Additional small widths used to snap fixed-size images to cache-friendly
 * buckets. Matches the next/image defaults.
 */
export const DEFAULT_IMAGE_SIZES: readonly number[] = [16, 32, 48, 64, 96, 128, 256, 384];

export interface ImageConfig {
  /** Loader used when a component does not pass its own `loader` prop. */
  loader: ImageLoader;
  /** Breakpoints used for responsive (`fill`/`sizes`) srcsets, ascending. */
  deviceSizes: readonly number[];
  /** Extra small widths merged into the snap list for fixed images. */
  imageSizes: readonly number[];
  /** Default quality when a component does not pass `quality`. */
  quality: number;
}

const defaults: ImageConfig = {
  loader: defaultLoader,
  deviceSizes: DEFAULT_DEVICE_SIZES,
  imageSizes: DEFAULT_IMAGE_SIZES,
  quality: DEFAULT_QUALITY,
};

let current: ImageConfig = defaults;

/**
 * Configure `<Image>` globally. Call once at module scope (for example in
 * `src/routes.ts`) so the configuration applies on the server and in the
 * browser. Individual components can still override via props.
 */
export function configureImage(overrides: Partial<ImageConfig>): void {
  current = {
    ...current,
    ...overrides,
    ...(overrides.deviceSizes
      ? { deviceSizes: [...overrides.deviceSizes].sort((a, b) => a - b) }
      : undefined),
    ...(overrides.imageSizes
      ? { imageSizes: [...overrides.imageSizes].sort((a, b) => a - b) }
      : undefined),
  };
}

export function getImageConfig(): ImageConfig {
  return current;
}

/** Restore the default configuration. Primarily useful in tests. */
export function resetImageConfig(): void {
  current = defaults;
}
