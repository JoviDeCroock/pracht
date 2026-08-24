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
import { PRESERVE_SCROLL_ATTRIBUTE } from "../src/runtime-constants.ts";
import { HISTORY_STATE_KEY } from "../src/scroll-restoration.ts";
import { SPECULATE_ATTRIBUTE } from "../src/runtime-constants.ts";
import type { SpeculationOption } from "../src/types.ts";

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

interface RouterOptions {
  viewTransitions?: boolean;
  speculation?: SpeculationOption;
}

describe("navigation UX primitives (client router)", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let scrollToSpy: ReturnType<typeof vi.fn>;
  // `initClientRouter` has no teardown, so without this every router from an
  // earlier test stays subscribed to the shared jsdom window and reacts to
  // events a later test dispatches.
  let routerListeners: Array<{
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  function createRouterApp(options?: RouterOptions) {
    return resolveApp(
      defineApp({
        viewTransitions: options?.viewTransitions,
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route("/next", "./routes/next.tsx", {
            id: "next",
            render: "ssr",
            speculation: options?.speculation,
          }),
        ],
      }),
    );
  }

  async function initRouter(options?: RouterOptions): Promise<void> {
    const targets: EventTarget[] = [window, document];
    const originals = targets.map((target) => target.addEventListener.bind(target));
    targets.forEach((target, i) => {
      target.addEventListener = ((
        type: string,
        handler: EventListenerOrEventListenerObject,
        opts?: boolean | AddEventListenerOptions,
      ) => {
        routerListeners.push({ target, type, handler, options: opts });
        originals[i](type, handler, opts);
      }) as typeof target.addEventListener;
    });

    try {
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
    } finally {
      targets.forEach((target, i) => {
        target.addEventListener = originals[i] as typeof target.addEventListener;
      });
    }
  }

  /** A skip-link-shaped fragment link plus the target it points at. */
  function mountFragmentLink(): {
    link: HTMLAnchorElement;
    target: HTMLElement;
    scrollIntoView: ReturnType<typeof vi.fn>;
  } {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<a id="fragment-link" href="#main">skip to content</a><main id="main">main content</main>`,
    );
    const target = document.getElementById("main")!;
    // jsdom does not implement scrollIntoView unless a test provides it.
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    return {
      link: document.getElementById("fragment-link") as HTMLAnchorElement,
      target,
      scrollIntoView,
    };
  }

  beforeEach(() => {
    routerListeners = [];
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
    for (const { target, type, handler, options } of routerListeners) {
      target.removeEventListener(type, handler, options as EventListenerOptions);
    }
    routerListeners = [];
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

  it("leaves a fragment entry the router did not create to the browser", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    document.body.insertAdjacentHTML("beforeend", `<main id="main">main content</main>`);

    fetchSpy.mockClear();
    scrollToSpy.mockClear();

    // A fragment navigation the click handler never saw — `location.hash =
    // "…"`, say: the browser pushes an entry of its own (no scroll key on
    // `history.state`) and fires popstate *before* scrolling to the fragment.
    history.pushState(null, "", "/#main");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await flush();
    await flush();

    // Nothing to re-resolve, and no scroll of the router's own — restoring a
    // saved position here is what used to undo the browser's jump.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
    // Focus follows the fragment, which is the half a skip link depends on.
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("still re-resolves the route when a keyless entry changes the path", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    fetchSpy.mockClear();

    // App code that wipes `history.state` (a stray `replaceState(null, …)`)
    // leaves entries without a scroll key. A missing key alone must not be
    // read as "fragment navigation" when the document actually changed.
    history.pushState(null, "", "/next");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenCalled();
    expect(root.textContent).toContain("next");
  });

  it("lands on the fragment when a traversal has no saved position", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    document.body.insertAdjacentHTML("beforeend", `<main id="main">main content</main>`);
    const target = document.getElementById("main")!;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    scrollToSpy.mockClear();

    // Traverse back onto a URL that carries a fragment, under a scroll key
    // nothing was ever saved for.
    const entryState = { [HISTORY_STATE_KEY]: "never-saved" };
    history.replaceState(entryState, "", "/#main");
    window.dispatchEvent(new PopStateEvent("popstate", { state: entryState }));
    await flush();
    await flush();

    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalledWith(0, 0);
  });

  it("commits an in-page fragment link click itself", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    const { link, target, scrollIntoView } = mountFragmentLink();
    fetchSpy.mockClear();
    scrollToSpy.mockClear();

    link.click();
    await flush();

    expect(window.location.hash).toBe("#main");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
    // The route is already rendered — there is no document to fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
    // The pushed entry carries a scroll key, so traversing back onto it later
    // restores like any other entry the router created.
    expect(typeof (history.state as Record<string, unknown>)?.[HISTORY_STATE_KEY]).toBe("string");
  });

  it("scrolls again when the same fragment link is clicked a second time", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    const { link, scrollIntoView } = mountFragmentLink();

    link.click();
    await flush();

    const entriesAfterFirstClick = history.length;
    scrollIntoView.mockClear();
    scrollToSpy.mockClear();
    fetchSpy.mockClear();

    // The user scrolled away and clicked the same link again. The browser
    // reuses the history entry for a repeat click, so the entry already
    // carries a scroll key — read as a traversal, the router would restore the
    // position saved for it (the top of the page) and the click would do
    // nothing at all.
    link.click();
    await flush();

    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // …and it must not pile up a duplicate history entry either.
    expect(history.length).toBe(entriesAfterFirstClick);
  });

  it("fires hashchange for a fragment link click, but not for a repeat click", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    const { link } = mountFragmentLink();

    const events: HashChangeEvent[] = [];
    const listener = (event: Event) => events.push(event as HashChangeEvent);
    window.addEventListener("hashchange", listener);
    try {
      link.click();
      await flush();

      // `pushState` fires nothing on its own; app code listening for the
      // platform event still needs to hear about the fragment change.
      expect(events).toHaveLength(1);
      expect(events[0].newURL).toContain("#main");

      link.click();
      await flush();

      // The hash did not change this time, so neither would the platform.
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener("hashchange", listener);
    }
  });

  it("skips the fragment scroll when the link opts out with preserveScroll", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    const { link, scrollIntoView } = mountFragmentLink();
    link.setAttribute(PRESERVE_SCROLL_ATTRIBUTE, "");
    scrollToSpy.mockClear();

    link.click();
    await flush();

    // The URL still updates — only the viewport is left alone.
    expect(window.location.hash).toBe("#main");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("still resolves the route for a link that changes the path and carries a fragment", async () => {
    fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
    await initRouter();
    document.body.insertAdjacentHTML("beforeend", `<a id="cross-doc" href="/next#main">next</a>`);
    fetchSpy.mockClear();

    (document.getElementById("cross-doc") as HTMLAnchorElement).click();
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenCalled();
    expect(root.textContent).toContain("next");
    expect(window.location.pathname).toBe("/next");
  });

  describe("prerender speculation hand-off", () => {
    let originalSupports: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalSupports = Object.getOwnPropertyDescriptor(HTMLScriptElement, "supports");
      Object.defineProperty(HTMLScriptElement, "supports", {
        configurable: true,
        value: (type: string) => type === "speculationrules",
      });
    });

    afterEach(() => {
      if (originalSupports) {
        Object.defineProperty(HTMLScriptElement, "supports", originalSupports);
      } else {
        delete (HTMLScriptElement as { supports?: unknown }).supports;
      }
    });

    /** Clicks a link to the prerender-marked `/next` route and reports whether
     * the router intercepted the click (SPA nav) or let the browser navigate. */
    async function clickPrerenderLink(markup: string): Promise<boolean> {
      fetchSpy.mockImplementation(async () => createJsonResponse({ data: null }));
      await initRouter({ speculation: "prerender" });
      document.body.insertAdjacentHTML("beforeend", markup);
      const anchor = document.getElementById("target") as HTMLAnchorElement;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(event);
      await flush();
      return event.defaultPrevented;
    }

    it("leaves the click to the browser so it can activate the prerendered document", async () => {
      expect(await clickPrerenderLink(`<a id="target" href="/next">next</a>`)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("handles a case-variant nofollow link itself — the rules never prerendered it", async () => {
      expect(await clickPrerenderLink(`<a id="target" href="/next" rel="NOFOLLOW">next</a>`)).toBe(
        true,
      );
      expect(window.location.pathname).toBe("/next");
    });

    it("handles a link inside a speculate=off scope itself", async () => {
      expect(
        await clickPrerenderLink(
          `<nav ${SPECULATE_ATTRIBUTE}="off"><a id="target" href="/next">next</a></nav>`,
        ),
      ).toBe(true);
      expect(window.location.pathname).toBe("/next");
    });
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
