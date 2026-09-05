import { useEffect, useRef } from "preact/hooks";
import type { Metric } from "web-vitals";

export type WebVitalsMetric = Metric;
export type WebVitalsReporter = (metric: WebVitalsMetric) => void;

const reporters = new Set<WebVitalsReporter>();
let observers: Promise<void> | undefined;

function publish(metric: WebVitalsMetric): void {
  for (const report of reporters) report(metric);
}

function ensureWebVitalsObservers(): Promise<void> {
  observers ??= import("web-vitals").then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
    // Register each observer once per document. The package buffers early
    // performance entries, so loading this chunk after hydration does not
    // sacrifice initial-navigation measurements.
    onCLS(publish);
    onFCP(publish);
    onINP(publish);
    onLCP(publish);
    onTTFB(publish);
  });
  return observers;
}

/**
 * Report CLS, FCP, INP, LCP, and TTFB from a client component.
 *
 * The measurement library is loaded lazily from an effect, so SSR is safe and
 * applications that do not call this hook ship none of its runtime. Multiple
 * hook instances share one observer set for the lifetime of the document.
 */
export function useWebVitals(report: WebVitalsReporter): void {
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    const subscriber: WebVitalsReporter = (metric) => reportRef.current(metric);
    reporters.add(subscriber);
    void ensureWebVitalsObservers();
    return () => {
      reporters.delete(subscriber);
    };
  }, []);
}
