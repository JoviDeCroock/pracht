import { h } from "preact";
import type { JSX, VNode } from "preact";

import { getImageConfig } from "./config.ts";
import type { ImageLoader } from "./loaders.ts";

export interface ImageProps extends Omit<
  JSX.HTMLAttributes<HTMLImageElement>,
  "src" | "srcset" | "srcSet" | "width" | "height" | "sizes" | "loading" | "alt" | "style"
> {
  /** Source path (`/hero.jpg`) or absolute URL. Passed to the loader. */
  src: string;
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
  style?: string | JSX.CSSProperties;
}

const FILL_STYLE: JSX.CSSProperties = {
  position: "absolute",
  height: "100%",
  width: "100%",
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

const FILL_STYLE_STRING = "position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;";

const warned = new Set<string>();

function isDevWarningsEnabled(): boolean {
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    ?.NODE_ENV;
  return typeof nodeEnv === "string" && nodeEnv !== "production";
}

function warnOnce(key: string, message: string): void {
  if (!isDevWarningsEnabled() || warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

function toDimension(value: number | `${number}` | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Snap a target width to the smallest configured size that covers it. */
function snapToSizes(allSizes: readonly number[], target: number): number {
  for (const size of allSizes) {
    if (size >= target) return size;
  }
  return allSizes[allSizes.length - 1];
}

interface SrcSetPlan {
  widths: number[];
  descriptor: "w" | "x";
}

function planSrcSet(
  deviceSizes: readonly number[],
  imageSizes: readonly number[],
  width: number | undefined,
  sizes: string | undefined,
): SrcSetPlan {
  const allSizes = [...imageSizes, ...deviceSizes].sort((a, b) => a - b);

  if (sizes) {
    // With a `sizes` attribute the browser picks from `w` descriptors. Trim
    // candidates that can never be selected based on the smallest `vw` hint.
    const viewportRatios: number[] = [];
    const vwPattern = /(^|\s)(1?\d?\d)vw/g;
    let match: RegExpExecArray | null = vwPattern.exec(sizes);
    while (match) {
      viewportRatios.push(Number.parseInt(match[2], 10));
      match = vwPattern.exec(sizes);
    }
    if (viewportRatios.length > 0) {
      const smallestRatio = Math.min(...viewportRatios) / 100;
      const floor = deviceSizes[0] * smallestRatio;
      const widths = allSizes.filter((size) => size >= floor);
      return { widths: widths.length > 0 ? widths : [...deviceSizes], descriptor: "w" };
    }
    return { widths: allSizes, descriptor: "w" };
  }

  if (width == null) {
    // `fill` without `sizes`: cover every device breakpoint.
    return { widths: [...deviceSizes], descriptor: "w" };
  }

  // Fixed layout: 1x and 2x candidates snapped to cache-friendly buckets.
  const oneX = snapToSizes(allSizes, width);
  const twoX = snapToSizes(allSizes, width * 2);
  return { widths: oneX === twoX ? [oneX] : [oneX, twoX], descriptor: "x" };
}

/**
 * Responsive, CLS-safe `<img>`. Renders plain markup — no client runtime, no
 * hydration requirement — and delegates URL generation to a pluggable
 * loader (see `configureImage()` and the `loader` prop).
 */
export function Image(props: ImageProps): VNode {
  const {
    src,
    alt,
    width,
    height,
    fill = false,
    sizes,
    quality,
    priority = false,
    loading,
    loader,
    style,
    ...rest
  } = props;

  const config = getImageConfig();
  const resolvedLoader = loader ?? config.loader;
  const resolvedQuality = quality ?? config.quality;
  const numericWidth = toDimension(width);
  const numericHeight = toDimension(height);

  if (isDevWarningsEnabled()) {
    if (!fill && (numericWidth == null || numericHeight == null)) {
      warnOnce(
        `dimensions:${src}`,
        `[pracht/image] <Image src="${src}"> is missing required "width" and "height" props. ` +
          `Provide the intrinsic dimensions (or use the "fill" prop) so the browser can ` +
          `reserve space and avoid layout shift.`,
      );
    }
    if (fill && (width != null || height != null)) {
      warnOnce(
        `fill-dimensions:${src}`,
        `[pracht/image] <Image src="${src}"> uses "fill" together with "width"/"height". ` +
          `"fill" images size themselves to their positioned parent; remove the explicit dimensions.`,
      );
    }
  }

  const effectiveSizes = sizes ?? (fill ? "100vw" : undefined);
  const plan = planSrcSet(config.deviceSizes, config.imageSizes, numericWidth, effectiveSizes);

  const candidates = plan.widths.map((candidateWidth) =>
    resolvedLoader({ src, width: candidateWidth, quality: resolvedQuality }),
  );
  const largestSrc = candidates[candidates.length - 1];

  // A loader that ignores width (e.g. passthroughLoader) produces identical
  // candidates; a srcset would be meaningless, so omit it.
  const optimized = new Set(candidates).size > 1;
  const srcset = optimized
    ? candidates
        .map((url, index) =>
          plan.descriptor === "w" ? `${url} ${plan.widths[index]}w` : `${url} ${index + 1}x`,
        )
        .join(", ")
    : undefined;

  let mergedStyle: string | JSX.CSSProperties | undefined = style;
  if (fill) {
    mergedStyle =
      typeof style === "string"
        ? `${FILL_STYLE_STRING}${style}`
        : { ...FILL_STYLE, ...(style as JSX.CSSProperties | undefined) };
  }

  const imgProps: Record<string, unknown> = {
    ...rest,
    src: largestSrc,
    alt,
    decoding: (rest as { decoding?: string }).decoding ?? "async",
    loading: loading ?? (priority ? "eager" : "lazy"),
  };

  if (srcset) imgProps.srcset = srcset;
  if (optimized && effectiveSizes) imgProps.sizes = effectiveSizes;
  if (!fill) {
    if (numericWidth != null) imgProps.width = numericWidth;
    if (numericHeight != null) imgProps.height = numericHeight;
  }
  if (priority) imgProps.fetchpriority = "high";
  if (mergedStyle != null) imgProps.style = mergedStyle;

  return h("img", imgProps);
}
