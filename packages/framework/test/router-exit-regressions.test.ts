// @vitest-environment jsdom
/**
 * Regressions for `navigate()`'s staleness rules, driven through the router
 * harness: a navigation that a newer one superseded, or whose route state a
 * mutation invalidated, must neither leave nor commit what it holds.
 */
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApp, route, useRouteData } from "../src/index.ts";
import { cacheRouteState, clearPrefetchCache } from "../src/prefetch-cache.ts";
import type { RouteStateResult } from "../src/runtime-client-fetch.ts";
import {
  chunkFailure,
  createDeferred,
  mountRouter,
  reply,
  settle,
  teardownRouterHarness,
  type StateReply,
} from "./router-harness.ts";

const app = resolveApp(
  defineApp({
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
      route("/a", "./routes/a.tsx", { id: "a", render: "ssr" }),
      route("/b", "./routes/b.tsx", { id: "b", render: "ssr" }),
    ],
    notFound: "./routes/not-found.tsx",
  }),
);

const page = (text: string) => async () => ({ default: () => h("main", null, text) });

/** Route `a` renders the `count` its loader data carries. */
function CountPage() {
  return h("main", null, `count:${(useRouteData() as { count?: number } | null)?.count}`);
}

function modules(a: () => Promise<unknown> = page("page a")) {
  return {
    "./routes/home.tsx": page("home"),
    "./routes/a.tsx": a,
    "./routes/b.tsx": page("page b"),
    "./routes/not-found.tsx": page("404"),
  };
}

afterEach(teardownRouterHarness);

describe("R445-1: a superseded navigation never leaves for its own URL", () => {
  // Each case holds `/a` at one await in `navigate()`, lets `/b` commit, then
  // releases `/a` into a document exit.
  const heldState: Array<[string, StateReply]> = [
    ["fetch-failed", reply.networkError()],
    ["opaque-redirect", reply.opaqueRedirect()],
    ["external-redirect", reply.redirect("https://elsewhere.example/x")],
    ["not-found-no-boundary", reply.error(404)],
  ];

  for (const [reason, released] of heldState) {
    it(`after the route-state await (${reason})`, async () => {
      const state = createDeferred<StateReply>();
      const harness = await mountRouter({
        app,
        routeModules: modules(),
        state: { "/a": reply.deferred(state.promise) },
      });

      const first = window.__PRACHT_NAVIGATE__!("/a");
      await settle(2);
      await harness.navigate("/b");
      state.resolve(released);
      await first;
      await settle();

      expect(harness.handoffs).toEqual([]);
      expect(window.location.pathname).toBe("/b");
      expect(harness.root.textContent).toBe("page b");
    });
  }

  it("after the not-found branch awaits the route chunk", async () => {
    const chunk = createDeferred<unknown>();
    const harness = await mountRouter({
      app,
      routeModules: modules(() => chunk.promise),
      state: { "/a": reply.error(404) },
    });

    const first = window.__PRACHT_NAVIGATE__!("/a");
    await settle(2);
    await harness.navigate("/b");
    chunk.resolve(chunkFailure());
    await first;
    await settle();

    expect(harness.handoffs).toEqual([]);
    expect(window.location.pathname).toBe("/b");
    expect(harness.root.textContent).toBe("page b");
  });

  it("after the route chunk await (chunk-failed)", async () => {
    const chunk = createDeferred<unknown>();
    const harness = await mountRouter({ app, routeModules: modules(() => chunk.promise) });

    const first = window.__PRACHT_NAVIGATE__!("/a");
    await settle(2);
    await harness.navigate("/b");
    chunk.resolve(chunkFailure());
    await first;
    await settle();

    expect(harness.handoffs).toEqual([]);
    expect(window.location.pathname).toBe("/b");
    expect(harness.root.textContent).toBe("page b");
  });
});

describe("R445-2: chunk recovery honours replace", () => {
  it("replaces the entry, so Back skips the page that never rendered", async () => {
    const harness = await mountRouter({ app, routeModules: modules(chunkFailure) });
    const lengthBefore = history.length;

    await harness.navigate("/a", { replace: true });

    expect(harness.handoffs).toEqual([{ kind: "replace", url: "/a" }]);
    expect(history.length).toBe(lengthBefore);
    expect(window.location.pathname).toBe("/");
  });

  it("pushes for a plain navigation", async () => {
    const harness = await mountRouter({ app, routeModules: modules(chunkFailure) });

    await harness.navigate("/a");

    expect(harness.handoffs).toEqual([{ kind: "href", url: "/a" }]);
  });
});

describe("a traversal whose route state redirects internally", () => {
  // `navigate(redirect, { ...opts })` carries `_popstate`, so the redirect
  // target commits without touching history.
  it("shows the target page under the target's URL", async () => {
    const harness = await mountRouter({
      app,
      routeModules: modules(),
      state: { "/a": reply.redirect("/b") },
    });

    await harness.popstate("/a");

    expect(harness.root.textContent).toBe("page b");
    expect(window.location.pathname).toBe("/b");
  });

  it("a push lands on the target's URL", async () => {
    const harness = await mountRouter({
      app,
      routeModules: modules(),
      state: { "/a": reply.redirect("/b") },
    });

    await harness.navigate("/a");

    expect(harness.root.textContent).toBe("page b");
    expect(window.location.pathname).toBe("/b");
    expect(harness.handoffs).toEqual([]);
  });
});

describe("the SPA boot's own document exits", () => {
  // A `render: "spa"` page fetches its loader data after the shell boots,
  // outside `navigate()`: the same exits, written a second time.
  const spaApp = resolveApp(
    defineApp({
      routes: [
        route("/a", "./routes/a.tsx", { id: "a", render: "spa" }),
        route("/b", "./routes/b.tsx", { id: "b", render: "spa" }),
      ],
    }),
  );
  const boot = (stateReply: StateReply) =>
    mountRouter({
      app: spaApp,
      routeModules: modules(),
      url: "/a",
      html: "",
      initialState: { data: undefined, pending: true, routeId: "a", url: "/a" },
      state: { "/a": stateReply },
    });

  it("reloads in place on an opaque redirect", async () => {
    const harness = await boot(reply.opaqueRedirect());
    expect(harness.handoffs).toEqual([{ kind: "href", url: "/a" }]);
  });

  it("reloads in place when the route state cannot be fetched", async () => {
    const harness = await boot(reply.networkError());
    expect(harness.handoffs).toEqual([{ kind: "href", url: "/a" }]);
  });

  it("refuses an unsafe redirect", async () => {
    const harness = await boot(reply.redirect("javascript:alert(1)"));
    expect(harness.handoffs).toEqual([]);
    expect(String(harness.errors.mock.calls[0]?.[0])).toMatch(/refused to navigate to unsafe URL/);
  });

  // Today both leave by `location.href`, so the redirecting page stays in
  // history and Back lands on it to redirect again. As in the exit table, a
  // row returns early (and so reports itself) once today's hand-off changes.
  for (const target of ["https://elsewhere.example/x", "/b"]) {
    it(`replaces the entry for a redirect to ${target}`, async () => {
      const harness = await boot(reply.redirect(target));
      expect(harness.handoffs).toEqual([{ kind: "replace", url: target }]);
    });
  }
});

describe("#487: the prefetch-invalidation generation", () => {
  function prefetch(url: string, result: RouteStateResult | Promise<RouteStateResult>): void {
    cacheRouteState(url, Promise.resolve(result));
  }

  /** `/a` served fresh by the server; its chunk is held until `release()`. */
  async function mountHeldCountPage(serverCount = 2) {
    const chunk = createDeferred<unknown>();
    const requested = createDeferred<void>();
    const harness = await mountRouter({
      app,
      routeModules: modules(() => {
        requested.resolve();
        return chunk.promise;
      }),
      state: { "/a": reply.data({ count: serverCount }) },
    });
    return {
      harness,
      requested: requested.promise,
      release: () => chunk.resolve({ default: CountPage }),
    };
  }

  it("refetches route state taken from the cache before a mutation, bypassing the HTTP cache", async () => {
    const { harness, requested, release } = await mountHeldCountPage();
    prefetch("/a", { type: "data", data: { count: 1 } });

    const navigation = window.__PRACHT_NAVIGATE__!("/a");
    await requested;
    clearPrefetchCache();
    release();
    await navigation;
    await settle();

    expect(harness.root.textContent).toBe("count:2");
    expect(window.location.pathname).toBe("/a");
    const refetches = harness.fetch.mock.calls.filter(([url]) => url === "/a");
    expect(refetches).toHaveLength(1);
    expect((refetches[0][1] as RequestInit).cache).toBe("reload");
  });

  it("retries once: a mutation during the refetch commits what the refetch returned", async () => {
    const { harness, requested, release } = await mountHeldCountPage();
    harness.setState("/a", reply.data({ count: 2 }));
    prefetch("/a", { type: "data", data: { count: 1 } });
    const originalFetch = harness.fetch.getMockImplementation()!;
    harness.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      clearPrefetchCache();
      return originalFetch(input, init);
    });

    const navigation = window.__PRACHT_NAVIGATE__!("/a");
    await requested;
    clearPrefetchCache();
    release();
    await navigation;
    await settle();

    expect(harness.root.textContent).toBe("count:2");
    expect(harness.fetched.filter((url) => url === "/a")).toHaveLength(1);
  });

  it("keeps replace on the refetch", async () => {
    const { harness, requested, release } = await mountHeldCountPage();
    prefetch("/a", { type: "data", data: { count: 1 } });
    const lengthBefore = history.length;

    const navigation = window.__PRACHT_NAVIGATE__!("/a", { replace: true });
    await requested;
    clearPrefetchCache();
    release();
    await navigation;
    await settle();

    expect(harness.root.textContent).toBe("count:2");
    expect(window.location.pathname).toBe("/a");
    expect(history.length).toBe(lengthBefore);
  });

  it("does not refetch for a navigation a newer one superseded", async () => {
    const { harness, requested, release } = await mountHeldCountPage();
    prefetch("/a", { type: "data", data: { count: 1 } });

    const navigation = window.__PRACHT_NAVIGATE__!("/a");
    await requested;
    clearPrefetchCache();
    await harness.navigate("/b");
    release();
    await navigation;
    await settle();

    expect(harness.root.textContent).toBe("page b");
    expect(harness.fetched.filter((url) => url === "/a")).toHaveLength(0);
  });

  it("does not refetch when the mutation lands after the commit", async () => {
    const { harness, release } = await mountHeldCountPage();
    prefetch("/a", { type: "data", data: { count: 1 } });

    release();
    await harness.navigate("/a");
    clearPrefetchCache();
    await settle();

    expect(harness.root.textContent).toBe("count:1");
    expect(harness.fetched.filter((url) => url === "/a")).toHaveLength(0);
  });

  // R487-2: the redirect is followed before the generation is compared.
  it("does not follow a redirect held from before a mutation", async () => {
    const held = createDeferred<RouteStateResult>();
    const harness = await mountRouter({
      app,
      routeModules: modules(),
      state: { "/a": reply.data(null) },
    });
    cacheRouteState("/a", held.promise);

    const navigation = window.__PRACHT_NAVIGATE__!("/a");
    await settle(2);
    // Signing in invalidates the "/a needs a login" answer still in flight.
    clearPrefetchCache();
    held.resolve({ type: "redirect", location: "/b" });
    await navigation;
    await settle();

    expect(window.location.pathname).toBe("/a");
    expect(harness.root.textContent).toBe("page a");
  });

  // R487-3: a view transition runs the commit after the generation check.
  it("does not commit stale state from inside a deferred view transition", async () => {
    const harness = await mountRouter({
      app,
      routeModules: modules(async () => ({ default: CountPage })),
      state: { "/a": reply.data({ count: 2 }) },
    });
    prefetch("/a", { type: "data", data: { count: 1 } });
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: vi.fn((update: () => Promise<void> | void) => {
        started.resolve();
        const done = gate.promise.then(() => update());
        return { finished: done, ready: done, updateCallbackDone: done };
      }),
    });

    try {
      const navigation = window.__PRACHT_NAVIGATE__!("/a", { viewTransition: true });
      await started.promise;
      clearPrefetchCache();
      gate.resolve();
      await navigation;
      await settle();

      expect(harness.root.textContent).toBe("count:2");
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });
});
