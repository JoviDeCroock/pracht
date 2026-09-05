// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const callbacks = new Map<string, (metric: unknown) => void>();
  return {
    callbacks,
    onCLS: vi.fn((callback: (metric: unknown) => void) => callbacks.set("CLS", callback)),
    onFCP: vi.fn((callback: (metric: unknown) => void) => callbacks.set("FCP", callback)),
    onINP: vi.fn((callback: (metric: unknown) => void) => callbacks.set("INP", callback)),
    onLCP: vi.fn((callback: (metric: unknown) => void) => callbacks.set("LCP", callback)),
    onTTFB: vi.fn((callback: (metric: unknown) => void) => callbacks.set("TTFB", callback)),
  };
});

vi.mock("web-vitals", () => mocks);

import { useWebVitals, type WebVitalsMetric } from "../src/web-vitals-hook.ts";

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("useWebVitals", () => {
  const roots: HTMLDivElement[] = [];

  afterEach(() => {
    for (const root of roots) {
      render(null, root);
      root.remove();
    }
    roots.length = 0;
  });

  it("lazily shares one observer set and always calls the latest reporters", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const latest = vi.fn();
    const root = document.createElement("div");
    roots.push(root);
    document.body.appendChild(root);

    function Probe({ report }: { report: (metric: WebVitalsMetric) => void }) {
      useWebVitals(report);
      return null;
    }

    render(h("div", null, h(Probe, { report: first }), h(Probe, { report: second })), root);
    expect(mocks.onCLS).not.toHaveBeenCalled();
    await flushEffects();

    for (const observe of [mocks.onCLS, mocks.onFCP, mocks.onINP, mocks.onLCP, mocks.onTTFB]) {
      expect(observe).toHaveBeenCalledTimes(1);
    }

    const metric = { name: "LCP", value: 123 } as WebVitalsMetric;
    mocks.callbacks.get("LCP")?.(metric);
    expect(first).toHaveBeenCalledWith(metric);
    expect(second).toHaveBeenCalledWith(metric);

    render(h("div", null, h(Probe, { report: latest }), h(Probe, { report: second })), root);
    await flushEffects();
    mocks.callbacks.get("CLS")?.({ name: "CLS", value: 0.01 } as WebVitalsMetric);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
