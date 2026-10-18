// @vitest-environment jsdom
import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../src/api-fetch.ts";
import { defineApp, resolveApp, route } from "../src/app.ts";
import { cacheRouteState, clearPrefetchCache, getCachedRouteState } from "../src/prefetch-cache.ts";
import { ensureCapabilityRevalidation } from "../src/runtime-capability-revalidate.ts";
import { revalidateRouteData } from "../src/runtime-revalidate.ts";
import { initClientRouter } from "../src/router.ts";
import { Form, useRouteData } from "../src/runtime-hooks.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function primePrefetchCache(): void {
  cacheRouteState("/other", Promise.resolve({ type: "data", data: { stale: true } }));
}

describe("every mutation path invalidates prefetched route state", () => {
  beforeEach(() => {
    clearPrefetchCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("an apiFetch mutation clears it, a read keeps it", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    primePrefetchCache();

    await apiFetch("/api/items" as never, { fetch: fetchImpl } as never);
    expect(getCachedRouteState("/other")).not.toBeNull();

    await apiFetch("/api/items" as never, { method: "POST", body: {}, fetch: fetchImpl } as never);
    expect(getCachedRouteState("/other")).toBeNull();
  });

  it("a <Form> submission clears what was prefetched while it was in flight", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        primePrefetchCache();
        return new Response(null, { status: 204 });
      }),
    );
    render(h(Form, { action: "/api/items", method: "post" }), root);

    root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCachedRouteState("/other")).toBeNull();
    render(null, root);
    root.remove();
  });

  it("useRevalidate() clears it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: null })),
    );
    primePrefetchCache();

    await revalidateRouteData({
      data: null,
      params: {},
      routeId: "home",
      setData: () => {},
      url: "/",
    });

    expect(getCachedRouteState("/other")).toBeNull();
  });

  it("a settled non-read capability clears it even when it skips revalidation", () => {
    ensureCapabilityRevalidation();
    const settle = (detail: Record<string, unknown>) =>
      window.dispatchEvent(new CustomEvent(CAPABILITY_SETTLED_EVENT, { detail }));
    primePrefetchCache();

    settle({ name: "notes.search", ok: true, effect: "read" });
    settle({ name: "notes.create", ok: false, effect: "write" });
    expect(getCachedRouteState("/other")).not.toBeNull();

    settle({ name: "notes.create", ok: true, effect: "write", revalidate: false });
    expect(getCachedRouteState("/other")).toBeNull();
  });
});

describe("a navigation in flight when a mutation lands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("refetches the route state it took from the prefetch cache", async () => {
    let releaseChunk!: (module: unknown) => void;
    let chunkRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      chunkRequested = resolve;
    });
    const chunk = new Promise<unknown>((resolve) => {
      releaseChunk = resolve;
    });
    document.body.innerHTML = '<div id="root"><main>home</main></div>';
    const root = document.querySelector<HTMLDivElement>("#root")!;
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Another mutation lands while the refetch is in flight; the reload
      // navigation commits what it fetched instead of retrying again.
      if (init?.method !== "POST") clearPrefetchCache();
      return json({ data: { count: 2 } });
    });
    vi.stubGlobal("fetch", fetcher);

    await initClientRouter({
      app: resolveApp(
        defineApp({
          routes: [
            route("/", "./home.tsx", {
              id: "home",
              render: "ssr",
              hasHead: false,
              hasLoader: false,
            }),
            route("/cart", "./cart.tsx", {
              id: "cart",
              render: "ssr",
              hasHead: false,
              hasLoader: true,
            }),
          ],
        }),
      ),
      root,
      shellModules: {},
      routeModules: {
        "./home.tsx": async () => ({ default: () => h("main", null, "home") }),
        "./cart.tsx": () => {
          chunkRequested();
          return chunk as Promise<never>;
        },
      },
      findModuleKey: (_modules, file) => file,
      initialState: { data: null, routeId: "home", url: "/" },
    });

    clearPrefetchCache();
    cacheRouteState("/cart", Promise.resolve({ type: "data", data: { count: 1 } }));
    const navigation = window.__PRACHT_NAVIGATE__!("/cart");
    await requested;
    // The navigation now holds the prefetched `{ count: 1 }` while its chunk loads.
    await apiFetch("/api/cart" as never, { method: "POST", body: { count: 2 } } as never);
    releaseChunk({
      default: () => h("main", null, `count:${(useRouteData() as { count: number }).count}`),
    });
    await navigation;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(window.location.pathname).toBe("/cart");
    expect(root.textContent).toBe("count:2");
    // The POST, then one fresh route-state request.
    expect(fetcher).toHaveBeenCalledTimes(2);
    render(null, root);
  });
});
