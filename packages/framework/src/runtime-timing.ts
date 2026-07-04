/**
 * Per-request phase timing for dev tooling.
 *
 * The runtime only records durations when a collector object is passed via
 * `HandlePrachtRequestOptions.timings` — the dev server passes one, production
 * adapters never do, so production requests skip all timing work.
 */

export interface PrachtPhaseTimings {
  /** Milliseconds spent in the middleware chain, excluding loader and render. */
  mw?: number;
  /** Milliseconds spent awaiting the route loader. */
  loader?: number;
  /** Milliseconds spent resolving modules and rendering the response, excluding the loader. */
  render?: number;
}

const PHASE_ORDER = ["mw", "loader", "render"] as const;

/**
 * Format collected phase timings as a standards-compliant `Server-Timing`
 * header value, e.g. `mw;dur=1.2, loader;dur=14.8, render;dur=3.1`.
 * Returns an empty string when nothing was recorded.
 */
export function formatServerTimingHeader(timings: PrachtPhaseTimings): string {
  const entries: string[] = [];
  for (const phase of PHASE_ORDER) {
    const duration = timings[phase];
    if (typeof duration === "number" && Number.isFinite(duration)) {
      entries.push(`${phase};dur=${formatDuration(duration)}`);
    }
  }

  return entries.join(", ");
}

function formatDuration(duration: number): string {
  return String(Math.max(0, Math.round(duration * 10) / 10));
}
