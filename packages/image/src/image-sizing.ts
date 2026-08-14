export interface ImageSrcSetPlan {
  widths: number[];
  descriptor: "w" | "x";
}

export function toImageDimension(value: number | `${number}` | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function planImageSrcSet(
  deviceSizes: readonly number[],
  imageSizes: readonly number[],
  width: number | undefined,
  sizes: string | undefined,
): ImageSrcSetPlan {
  const allSizes = [...imageSizes, ...deviceSizes].sort((left, right) => left - right);

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

/** Snap a target width to the smallest configured size that covers it. */
function snapToSizes(allSizes: readonly number[], target: number): number {
  for (const size of allSizes) {
    if (size >= target) return size;
  }
  return allSizes[allSizes.length - 1];
}
