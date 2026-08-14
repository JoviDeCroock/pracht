import { h } from "preact";
import type { VNode } from "preact";

import { getImageConfig } from "./config.ts";
import { warnForImageProps } from "./image-diagnostics.ts";
import { planImageSrcSet, toImageDimension } from "./image-sizing.ts";
import { isSafeBlurDataURL, mergeImageStyle } from "./image-style.ts";
import type { ImageProps } from "./image-types.ts";

export type { ImageProps } from "./image-types.ts";

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
  const numericWidth = toImageDimension(width) ?? (fill ? undefined : metadata?.width);
  const numericHeight = toImageDimension(height) ?? (fill ? undefined : metadata?.height);
  const resolvedBlurDataURL =
    placeholder === "blur" ? (blurDataURL ?? metadata?.blurDataURL) : undefined;
  const safeBlurDataURL =
    resolvedBlurDataURL != null && isSafeBlurDataURL(resolvedBlurDataURL)
      ? resolvedBlurDataURL
      : undefined;

  warnForImageProps({
    src: srcString,
    fill,
    width,
    height,
    numericWidth,
    numericHeight,
    placeholder,
    resolvedBlurDataURL,
    safeBlurDataURL,
  });

  const effectiveSizes = sizes ?? (fill ? "100vw" : undefined);
  const plan = planImageSrcSet(config.deviceSizes, config.imageSizes, numericWidth, effectiveSizes);
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

  // Style precedence: blur background, then fill positioning, then the user's
  // style (last wins, matching the previous fill/style behavior).
  const mergedStyle = mergeImageStyle(style, safeBlurDataURL, fill);
  if (mergedStyle != null) imgProps.style = mergedStyle;

  return h("img", imgProps);
}
