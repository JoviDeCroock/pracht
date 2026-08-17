import { h } from "preact";
import type { JSX, VNode } from "preact";

import { getImageConfig } from "./config.ts";
import type { ImageLoader } from "./loaders.ts";
import type { PrachtImageMetadata } from "./metadata.ts";

type ImageElementProps = JSX.IntrinsicElements["img"];
type SignalValue = { value: unknown };
type ImageCssProperties = Exclude<NonNullable<ImageElementProps["style"]>, string | SignalValue>;

export interface ImageProps extends Omit<
  ImageElementProps,
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
  style?: string | ImageCssProperties;
}

const FILL_STYLE: ImageCssProperties = {
  position: "absolute",
  height: "100%",
  width: "100%",
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

const FILL_STYLE_STRING = "position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;";

// Strict shape for blur data URIs before they are interpolated into an inline
// style. The character set after the comma (base64 plus percent-encoding)
// excludes quotes, parentheses, backslashes, and whitespace, so a value that
// matches cannot break out of `url("…")` and inject CSS.
const BLUR_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=+-]+)*,[a-z0-9+/=._%-]*$/i;

function blurBackground(blurDataURL: string): {
  styleString: string;
  styleObject: ImageCssProperties;
} {
  const image = `url("${blurDataURL}")`;
  return {
    styleString:
      `background-image:${image};background-size:cover;` +
      "background-position:50% 50%;background-repeat:no-repeat;",
    styleObject: {
      backgroundImage: image,
      backgroundSize: "cover",
      backgroundPosition: "50% 50%",
      backgroundRepeat: "no-repeat",
    },
  };
}

const warned = new Set<string>();

function getNodeEnv(): string | undefined {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
}

// Every read must spell out `import.meta.env?.<KEY>` literally. Vite statically
// replaces those exact member expressions at build time, but a bare
// `import.meta.env` read is materialized into an object literal holding every
// exposed env value — including `VITE_`-prefixed ones — which would ship those
// values in the client bundle and slip past the name-based env leak scan. In
// Node (CLI builds, tests) `import.meta.env` is undefined and the optional
// chain yields undefined.
function getImportMetaDev(): boolean | undefined {
  const mode = import.meta.env?.MODE;
  if (mode === "production") return false;
  const dev = import.meta.env?.DEV;
  if (typeof dev === "boolean") return dev;
  if (typeof mode === "string") return mode !== "production";
  return undefined;
}

function isDevWarningsEnabled(): boolean {
  const nodeEnv = getNodeEnv();
  if (nodeEnv === "production") return false;
  if (typeof nodeEnv === "string") return true;

  return getImportMetaDev() ?? false;
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
    placeholder = "empty",
    blurDataURL,
    style,
    ...rest
  } = props;

  // `src` may be the metadata object of a build-time `?pracht` import; it
  // supplies intrinsic dimensions and the blur placeholder without repeating
  // them as props. Explicit props always win.
  const metadata = typeof src === "string" ? undefined : src;
  const srcString = typeof src === "string" ? src : src.src;

  const config = getImageConfig();
  const resolvedLoader = loader ?? config.loader;
  const resolvedQuality = quality ?? config.quality;
  const numericWidth = toDimension(width) ?? (fill ? undefined : metadata?.width);
  const numericHeight = toDimension(height) ?? (fill ? undefined : metadata?.height);
  const resolvedBlurDataURL =
    placeholder === "blur" ? (blurDataURL ?? metadata?.blurDataURL) : undefined;
  const safeBlurDataURL =
    resolvedBlurDataURL != null && BLUR_DATA_URL_PATTERN.test(resolvedBlurDataURL)
      ? resolvedBlurDataURL
      : undefined;

  if (isDevWarningsEnabled()) {
    if (!fill && (numericWidth == null || numericHeight == null)) {
      warnOnce(
        `dimensions:${srcString}`,
        `[pracht/image] <Image src="${srcString}"> is missing required "width" and "height" props. ` +
          `Provide the intrinsic dimensions (or use the "fill" prop) so the browser can ` +
          `reserve space and avoid layout shift.`,
      );
    }
    if (fill && (width != null || height != null)) {
      warnOnce(
        `fill-dimensions:${srcString}`,
        `[pracht/image] <Image src="${srcString}"> uses "fill" together with "width"/"height". ` +
          `"fill" images size themselves to their positioned parent; remove the explicit dimensions.`,
      );
    }
    if (placeholder === "blur" && resolvedBlurDataURL == null) {
      warnOnce(
        `blur-missing:${srcString}`,
        `[pracht/image] <Image src="${srcString}"> uses placeholder="blur" without a blurDataURL. ` +
          `Import the image with the "?pracht" query (via prachtImage() from "@pracht/image/vite") ` +
          `or pass a blurDataURL prop. Rendering without a placeholder.`,
      );
    }
    if (resolvedBlurDataURL != null && safeBlurDataURL == null) {
      warnOnce(
        `blur-invalid:${srcString}`,
        `[pracht/image] <Image src="${srcString}"> received a blurDataURL that is not a ` +
          `well-formed "data:image/…" URI. It was ignored because interpolating arbitrary ` +
          `strings into the style attribute could inject CSS.`,
      );
    }
  }

  const effectiveSizes = sizes ?? (fill ? "100vw" : undefined);
  const plan = planSrcSet(config.deviceSizes, config.imageSizes, numericWidth, effectiveSizes);

  const candidates = plan.widths.map((candidateWidth) =>
    resolvedLoader({ src: srcString, width: candidateWidth, quality: resolvedQuality }),
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

  // Style precedence: blur background, then fill positioning, then the user's
  // style (last wins, matching the previous fill/style behavior). The blur is
  // a plain CSS background on the <img> itself: SSR-safe, zero hydration —
  // the real image covers it as soon as it paints.
  const blur = safeBlurDataURL != null ? blurBackground(safeBlurDataURL) : undefined;
  let mergedStyle: string | ImageCssProperties | undefined = style;
  if (blur || fill) {
    const baseString = `${blur?.styleString ?? ""}${fill ? FILL_STYLE_STRING : ""}`;
    mergedStyle =
      typeof style === "string"
        ? `${baseString}${style}`
        : {
            ...blur?.styleObject,
            ...(fill ? FILL_STYLE : undefined),
            ...(style as ImageCssProperties | undefined),
          };
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
