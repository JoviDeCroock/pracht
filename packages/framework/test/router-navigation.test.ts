// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route, Form } from "../src/index.ts";
import {
  _resetNavigationForTesting,
  getNavigation,
  subscribeToNavigation,
  type Navigation,
} from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";
import { HISTORY_STATE_KEY } from "../src/scroll-restoration.ts";

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("navigation UX primitives (client router)", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let scrollToSpy: ReturnType<typeof vi.fn>;

  function createRouterApp(options?: { viewTransitions?: boolean }) {
    return resolveApp(
      defineApp({
        viewTransitions: options?.viewTransitions,
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route("/next", "./routes/next.tsx", { id: "next", render: "ssr" }),
        ],
      }),
    );
  }

  async function initRouter(options?: { viewTransitions?: boolean }): Promise<void> {
    await initClientRouter({
      app: createRouterApp(options),
      routeModules: {
        "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
        "./routes/next.tsx": async () => ({ default: () => h("main", null, "next") }),
      },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules, file) => file,
    });
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    scrollToSpy = vi.fn();
    window.scrollTo = scrollToSpy as unknown as typeof window.scrollTo;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    sessionStorage.clear();
    clearPrefetchCache();
    _resetNavigationForTesting();
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
    _resetNavigationForTesting();
  });

  it("transitions loading → idle around a navigation with an in-flight route-state fetch", async () => {
    const deferred = createDeferred<Response>();
    fetchSpy.mockReturnValue(deferred.promise);
    await initRouter();

    const transitions: Navigation[] = [];
    const unsubscribe = subscribeToNavigation((navigation) => transitions.push(navigation));

    const navigation = window.__PRACHT_NAVIGATE__!("/next?tab=a");

    expect(getNavigation()).toEqual({
      state: "loading",
      location: { hash: "", href: "/next?tab=a", pathname: "/next", search: "?tab=a" },
    });

    deferred.resolve(createJsonResponse({ data: { ok: true } }));
    await navigation;
    await flush();

    expect(getNavigation()).toEqual({ state: "idle" });
    expect(transitions.map((t) => t.state)).toEqual(["loading", "idle"]);
    expect(root.textContent).toContain("next");
    unsubscribe();
  });

  it("settles a superseded navigation without clobbering the newer one", async () => {
    const slow = createDeferred<Response>();
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/next")) return slow.promise;
      return createJsonResponse({ data: null });
    });
    await initRouter();

    const first = window.__PRACHT_NAVIGATE__!("/next");
    const second = window.__PRACHT_NAVIGATE__!("/");

    await second;
    await flush();
    expect(getNavigation()).toEqual({ state: "idle" });

    slow.resolve(createJsonResponse({ data: null }));
    await first;
    await flush();
    expect(getNavigation()).toEqual({ state: "idle" });
    expect(window.location.pathname).toBe("/");
  });

  it("exposes submitting state (with formData) during <Form> submissions", async () => {
    const deferred = createDeferred<Response>();
    fetchSpy.mockReturnValue(deferred.promise);

    render(
      h(
        Form,
        { action: "/api/projects", method: "post" },
        h("input", { name: "title", value: "hello" }),
      ),
      root,
    );
    await flush();

    const form = root.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    const navigation = getNavigation();
    expect(navigation.state).toBe("submitting");
    expect(navigation.location?.pathname).toBe("/api/projects");
    expect(navigation.formData?.get("title")).toBe("hello");

    deferred.resolve(new Response(null, { status: 204 }));
    await flush();
    expect(getNavigation()).toEqual({ state: "idle" });
  });

  it("scrolls to the top after a forward navigation by default", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
  });

  it("skips the scroll reset when preserveScroll is set", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();

    await window.__PRACHT_NAVIGATE__!("/next", { preserveScroll: true });
    await flush();

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("restores the saved scroll position on popstate navigations", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();

    // Simulate the user having scrolled down on the initial entry.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 800 });
    const initialEntryState = history.state as Record<string, unknown>;
    expect(typeof initialEntryState?.[HISTORY_STATE_KEY]).toBe("string");

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    scrollToSpy.mockClear();

    // Simulate the browser traversing back to the initial entry.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    history.replaceState(initialEntryState, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate", { state: initialEntryState }));
    await flush();
    await flush();

    expect(scrollToSpy).toHaveBeenCalledWith(0, 800);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("sets history.scrollRestoration to manual when supported", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();

    if ("scrollRestoration" in history) {
      expect(history.scrollRestoration).toBe("manual");
    }
  });

  it("wraps the commit in document.startViewTransition when the navigation opts in", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    const startViewTransition = vi.fn((callback: () => void | Promise<void>) => ({
      updateCallbackDone: Promise.resolve().then(() => callback()) as Promise<void>,
    }));
    (document as { startViewTransition?: unknown }).startViewTransition = startViewTransition;

    await initRouter();
    await window.__PRACHT_NAVIGATE__!("/next", { viewTransition: true });
    await flush();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("next");
    expect(window.location.pathname).toBe("/next");
  });

  it("uses view transitions for every navigation when enabled app-wide", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    const startViewTransition = vi.fn((callback: () => void | Promise<void>) => ({
      updateCallbackDone: Promise.resolve().then(() => callback()) as Promise<void>,
    }));
    (document as { startViewTransition?: unknown }).startViewTransition = startViewTransition;

    await initRouter({ viewTransitions: true });
    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("next");

    // A navigation can still opt out explicitly.
    await window.__PRACHT_NAVIGATE__!("/", { viewTransition: false });
    await flush();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });

  it("commits normally when startViewTransition is unavailable", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter({ viewTransitions: true });

    await window.__PRACHT_NAVIGATE__!("/next", { viewTransition: true });
    await flush();

    expect(root.textContent).toContain("next");
    expect(window.location.pathname).toBe("/next");
    expect(getNavigation()).toEqual({ state: "idle" });
  });
});
