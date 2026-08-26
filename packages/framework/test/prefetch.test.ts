// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApp, route } from "../src/app.ts";
import { clearPrefetchCache, getCachedRouteState } from "../src/prefetch-cache.ts";
import { prefetch, prefetchRouteState, registerPrefetchTarget } from "../src/prefetch-api.ts";
import { setupPrefetching } from "../src/prefetch.ts";
import type { ResolvedPrachtApp } from "../src/types.ts";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function createApp(): ResolvedPrachtApp {
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
        route("/pricing", "./routes/pricing.tsx", { id: "pricing", render: "ssr" }),
        route("/viewport-page", "./routes/viewport.tsx", {
          id: "viewport-page",
          render: "ssr",
          prefetch: "viewport",
        }),
        route("/quiet", "./routes/quiet.tsx", {
          id: "quiet",
          render: "ssr",
          prefetch: "none",
        }),
        route("/static-doc", "./routes/static-doc.tsx", {
          id: "static-doc",
          render: "ssr",
          hydration: "none",
        }),
      ],
    }),
  );
}

function createSpeculationApp(path: string): ResolvedPrachtApp {
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
        route(path, "./routes/pricing.tsx", {
          id: "pricing",
          render: "ssr",
          speculation: "prerender",
        }),
      ],
    }),
  );
}

function addAnchor(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  document.body.appendChild(anchor);
  return anchor;
}

function hover(anchor: HTMLAnchorElement): void {
  anchor.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
}

function stubSpeculationRulesSupport(supported: boolean): void {
  Object.defineProperty(HTMLScriptElement, "supports", {
    configurable: true,
    value: vi.fn((type: string) => supported && type === "speculationrules"),
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("prefetch strategies", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    clearPrefetchCache();
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue(createJsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-pracht-speculate");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("prefetches on hover intent and caches the result for later navigations", async () => {
    const anchor = addAnchor("/pricing");
    setupPrefetching(createApp());

    hover(anchor);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/pricing",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-pracht-route-state-request": "1" }),
      }),
    );
    expect(fetchSpy.mock.calls[0][1].headers).not.toHaveProperty("Cache-Control");

    // The navigation path reads the same cache — no second request.
    const cached = getCachedRouteState("/pricing");
    expect(cached).not.toBeNull();
    await expect(cached).resolves.toEqual({ type: "data", data: { ok: true } });

    hover(anchor);
    vi.advanceTimersByTime(60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("catches up hover intent that began before the lazy listeners loaded", () => {
    const anchor = addAnchor("/pricing");
    const querySelector = vi
      .spyOn(document, "querySelector")
      .mockImplementation((selector) => (selector === "a:hover" ? anchor : null));

    setupPrefetching(createApp());
    vi.advanceTimersByTime(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/pricing");
    querySelector.mockRestore();
  });

  it('honors a per-anchor data-pracht-prefetch="none" override on hover', () => {
    const anchor = addAnchor("/pricing", { "data-pracht-prefetch": "none" });
    setupPrefetching(createApp());

    hover(anchor);
    vi.advanceTimersByTime(200);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honors a route-level prefetch "none" default on hover', () => {
    const anchor = addAnchor("/quiet");
    setupPrefetching(createApp());

    hover(anchor);
    vi.advanceTimersByTime(200);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honors a per-anchor "intent" override on a route configured with prefetch "none"', () => {
    const anchor = addAnchor("/quiet", { "data-pracht-prefetch": "intent" });
    setupPrefetching(createApp());

    hover(anchor);
    vi.advanceTimersByTime(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/quiet");
  });

  it("does not prefetch route state for no-hydration routes", () => {
    const anchor = addAnchor("/static-doc", { "data-pracht-prefetch": "intent" });
    setupPrefetching(createApp());

    hover(anchor);
    vi.advanceTimersByTime(60);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefetches "render" links immediately when scanned', () => {
    addAnchor("/pricing", { "data-pracht-prefetch": "render" });
    setupPrefetching(createApp());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/pricing");
  });

  it('prefetches "render" links added to the DOM after setup', async () => {
    setupPrefetching(createApp());
    expect(fetchSpy).not.toHaveBeenCalled();

    addAnchor("/pricing", { "data-pracht-prefetch": "render" });
    // MutationObserver callbacks are delivered as microtasks.
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/pricing");
  });

  it("never prefetches hrefs that match no route", () => {
    const anchor = addAnchor("/definitely-not-a-route", { "data-pracht-prefetch": "render" });
    setupPrefetching(createApp());

    hover(anchor);
    vi.advanceTimersByTime(200);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps JS prefetch as the fallback for prerender routes when speculation rules are unsupported", () => {
    stubSpeculationRulesSupport(false);
    const anchor = addAnchor("/prerender-fallback");
    setupPrefetching(createSpeculationApp("/prerender-fallback"));

    hover(anchor);
    vi.advanceTimersByTime(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/prerender-fallback");
  });

  it("suppresses JS prefetch for prerender routes when speculation rules are supported", () => {
    stubSpeculationRulesSupport(true);
    const anchor = addAnchor("/prerender-supported");
    setupPrefetching(createSpeculationApp("/prerender-supported"));

    hover(anchor);
    vi.advanceTimersByTime(200);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps JS prefetch for a nofollow anchor the speculation rules exclude", () => {
    stubSpeculationRulesSupport(true);
    const anchor = addAnchor("/prerender-nofollow", { rel: "nofollow" });
    setupPrefetching(createSpeculationApp("/prerender-nofollow"));

    hover(anchor);
    vi.advanceTimersByTime(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/prerender-nofollow");
  });

  it('keeps JS prefetch for anchors inside a data-pracht-speculate="off" scope', () => {
    stubSpeculationRulesSupport(true);
    const nav = document.createElement("nav");
    nav.setAttribute("data-pracht-speculate", "off");
    document.body.appendChild(nav);
    const anchor = document.createElement("a");
    anchor.href = "/prerender-scoped-off";
    nav.appendChild(anchor);
    setupPrefetching(createSpeculationApp("/prerender-scoped-off"));

    hover(anchor);
    vi.advanceTimersByTime(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/prerender-scoped-off");
  });

  it("starts render prefetch when a mounted prerender link becomes excluded", async () => {
    stubSpeculationRulesSupport(true);
    const nav = document.createElement("nav");
    document.body.appendChild(nav);
    const anchor = document.createElement("a");
    anchor.href = "/prerender-dynamic-off";
    anchor.setAttribute("data-pracht-prefetch", "render");
    nav.appendChild(anchor);
    setupPrefetching(createSpeculationApp("/prerender-dynamic-off"));
    expect(fetchSpy).not.toHaveBeenCalled();

    nav.setAttribute("data-pracht-speculate", "off");
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/prerender-dynamic-off");
  });

  it("starts render prefetch when the document root becomes excluded", async () => {
    stubSpeculationRulesSupport(true);
    const anchor = addAnchor("/prerender-root-off", {
      "data-pracht-prefetch": "render",
    });
    setupPrefetching(createSpeculationApp("/prerender-root-off"));
    expect(fetchSpy).not.toHaveBeenCalled();

    document.documentElement.setAttribute("data-pracht-speculate", "off");
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/prerender-root-off");

    document.documentElement.removeAttribute("data-pracht-speculate");
    await flushMicrotasks();
    anchor.remove();
  });

  it("drops viewport prefetch when an excluded link becomes eligible for prerender", async () => {
    stubSpeculationRulesSupport(true);
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const fakeObserver: IntersectionObserver = {
      disconnect: vi.fn(),
      observe,
      root: null,
      rootMargin: "200px",
      scrollMargin: "0px",
      takeRecords: vi.fn(() => []),
      thresholds: [0],
      unobserve,
    };
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn((callback: IntersectionObserverCallback) => {
        intersectionCallback = callback;
        return fakeObserver;
      }),
    );
    const anchor = addAnchor("/prerender-dynamic-on", {
      "data-pracht-prefetch": "viewport",
      "data-pracht-speculate": "off",
    });
    setupPrefetching(createSpeculationApp("/prerender-dynamic-on"));
    expect(observe).toHaveBeenCalledWith(anchor);

    anchor.setAttribute("data-pracht-speculate", "on");
    await flushMicrotasks();
    expect(unobserve).toHaveBeenCalledWith(anchor);

    const emptyRect: DOMRectReadOnly = {
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    const entry: IntersectionObserverEntry = {
      boundingClientRect: emptyRect,
      intersectionRatio: 1,
      intersectionRect: emptyRect,
      isIntersecting: true,
      rootBounds: null,
      target: anchor,
      time: 0,
    };
    intersectionCallback?.([entry], fakeObserver);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("imperative prefetch()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearPrefetchCache();
    fetchSpy = vi.fn().mockResolvedValue(createJsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("warms modules and caches route state for a matching href", async () => {
    const app = createApp();
    const warmModules = vi.fn();
    registerPrefetchTarget(app, warmModules);

    await prefetch("/pricing");

    expect(warmModules).toHaveBeenCalledTimes(1);
    expect(warmModules.mock.calls[0][0].route.id).toBe("pricing");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getCachedRouteState("/pricing")).not.toBeNull();
  });

  it("supports typed route targets", async () => {
    const app = createApp();
    registerPrefetchTarget(app, vi.fn());

    await prefetch({ route: "pricing", search: { ref: "menu" } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/pricing?ref=menu");
  });

  it("is a no-op for unmatched or cross-origin URLs", async () => {
    const app = createApp();
    registerPrefetchTarget(app, vi.fn());

    await prefetch("/nope");
    await prefetch("https://external.example/pricing");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("evicts rejected prefetches from the cache instead of poisoning navigation", async () => {
    const app = createApp();
    registerPrefetchTarget(app, vi.fn());
    fetchSpy.mockRejectedValue(new Error("network down"));

    await prefetch("/pricing");
    // Let the eviction .catch() handler run.
    await Promise.resolve();

    expect(getCachedRouteState("/pricing")).toBeNull();
  });

  it("skips the server fetch for routes that need none", async () => {
    const app = resolveApp(
      defineApp({
        routes: [
          route("/static", "./routes/static.tsx", {
            id: "static",
            render: "ssg",
            hasLoader: false,
            hasHead: false,
          }),
        ],
      }),
    );

    await expect(prefetchRouteState("/static", app.routes[0])).resolves.toEqual({
      type: "data",
      data: undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
