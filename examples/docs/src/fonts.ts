import { defineFont } from "@pracht/core";

/**
 * Self-hosted Inter (variable, latin subset — SIL OFL 1.1). Registered via
 * the `fonts` head array in both shells; the metric overrides are the
 * published Inter-vs-Arial values (same numbers next/font uses), so the
 * Arial-based fallback face prevents layout shift while the file loads.
 */
export const inter = defineFont({
  family: "Inter",
  src: "/fonts/inter-latin-var.woff2",
  weight: "100 900",
  fallbacks: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Helvetica",
    "Arial",
    "sans-serif",
  ],
  metricsFallback: "Arial",
  sizeAdjust: "107.4%",
  ascentOverride: "90.2%",
  descentOverride: "22.48%",
  lineGapOverride: "0%",
});
