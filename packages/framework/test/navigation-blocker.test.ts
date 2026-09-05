// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import {
  _resetBlockerForTesting,
  getBlockerSnapshot,
  HISTORY_INDEX_KEY,
  proceedBlockedNavigation,
  readHistoryIndex,
  registerBlocker,
  resetBlockedNavigation,
  shouldBlockNavigation,
  subscribeToBlocker,
  withHistoryIndex,
  type BlockerArgs,
} from "../src/navigation-blocker.ts";
import { _resetNavigationForTesting } from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

/** The router passes plain hrefs; the store parses them into locations. */
const PUSH_TO_NEXT = ["/", "/next", "push"] as const;
const NEXT_LOCATION = { hash: "", href: "/next", pathname: "/next", search: "" };

describe("navigation blocker store", () => {
  afterEach(() => {
    _resetBlockerForTesting();
    vi.restoreAllMocks();
  });

  it("does nothing when no guard is registered", () => {
    const retry = vi.fn();
    expect(shouldBlockNavigation(...PUSH_TO_NEXT, retry)).toBe(false);
    expect(getBlockerSnapshot()).toEqual({ state: "unblocked", location: null });
    expect(retry).not.toHaveBeenCalled();
  });

  it("blocks, exposes the destination, and resumes exactly once on proceed", () => {
    registerBlocker(() => true);
    const retry = vi.fn();

    expect(shouldBlockNavigation(...PUSH_TO_NEXT, retry)).toBe(true);
    expect(getBlockerSnapshot()).toEqual({ state: "blocked", location: NEXT_LOCATION });
    expect(retry).not.toHaveBeenCalled();

    proceedBlockedNavigation();
    expect(retry).toHaveBeenCalledTimes(1);

    // The retried navigation passes straight through, and the pass is spent —
    // the *next* navigation is guarded again.
    expect(shouldBlockNavigation(...PUSH_TO_NEXT, retry)).toBe(false);
    expect(getBlockerSnapshot()).toEqual({ state: "unblocked", location: null });
    expect(shouldBlockNavigation(...PUSH_TO_NEXT, retry)).toBe(true);
  });

  it("abandons the navigation on reset without retrying it", () => {
    registerBlocker(() => true);
    const retry = vi.fn();

    shouldBlockNavigation(...PUSH_TO_NEXT, retry);
    resetBlockedNavigation();

    expect(retry).not.toHaveBeenCalled();
    expect(getBlockerSnapshot()).toEqual({ state: "unblocked", location: null });
  });

  it("ignores a second navigation while one is already blocked", () => {
    registerBlocker(() => true);
    const first = vi.fn();
    const second = vi.fn();

    expect(shouldBlockNavigation(...PUSH_TO_NEXT, first)).toBe(true);
    // Blocking again would replace the retry the guard is holding and lose the
    // first destination, so the second navigation is simply not intercepted.
    expect(shouldBlockNavigation("/", "/next", "pop", second)).toBe(false);

    proceedBlockedNavigation();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("passes the pending navigation to a predicate guard", () => {
    const shouldBlock = vi.fn((args: BlockerArgs) => args.nextLocation?.pathname !== "/allowed");
    registerBlocker(shouldBlock);

    expect(shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn())).toBe(true);
    resetBlockedNavigation();
    expect(shouldBlockNavigation("/", "/allowed", "push", vi.fn())).toBe(false);
    expect(shouldBlock).toHaveBeenCalledTimes(2);
  });

  it("fails open and reports when a guard throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerBlocker(() => {
      throw new Error("boom");
    });

    expect(shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn())).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it("releases a blocked navigation when the guard unmounts", () => {
    const unregister = registerBlocker(() => true);
    shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn());
    expect(getBlockerSnapshot().state).toBe("blocked");

    unregister();

    // Otherwise the router keeps a retry nobody is left to trigger.
    expect(getBlockerSnapshot()).toEqual({ state: "unblocked", location: null });
    expect(shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn())).toBe(false);
  });

  it("notifies subscribers on every state change", () => {
    const listener = vi.fn();
    registerBlocker(() => true);
    const unsubscribe = subscribeToBlocker(listener);

    shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn());
    expect(listener).toHaveBeenCalledTimes(1);
    resetBlockedNavigation();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("guards document unloads through beforeunload", () => {
    registerBlocker((args) => args.historyAction === "unload");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // Opting out removes the listener rather than merely ignoring the event.
    _resetBlockerForTesting();
    registerBlocker(() => true, { beforeUnload: false });
    const allowed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
  });

  it("warns when a second guard is registered over an active one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBlocker(() => false);
    registerBlocker(() => true);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("second useBlocker()"));
    // The newest guard is the one that runs.
    expect(shouldBlockNavigation(...PUSH_TO_NEXT, vi.fn())).toBe(true);
  });
});

describe("history entry index", () => {
  it("round-trips through history state without discarding other keys", () => {
    expect(readHistoryIndex(null)).toBeNull();
    expect(readHistoryIndex({ other: 1 })).toBeNull();
    expect(readHistoryIndex({ [HISTORY_INDEX_KEY]: "2" })).toBeNull();
    expect(readHistoryIndex(withHistoryIndex({ other: 1 }, 3))).toBe(3);
    expect(withHistoryIndex({ other: 1 }, 3)).toEqual({ other: 1, [HISTORY_INDEX_KEY]: 3 });
    expect(withHistoryIndex("not an object", 0)).toEqual({ [HISTORY_INDEX_KEY]: 0 });
  });
});

describe("client router integration", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let routerListeners: Array<{
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  async function initRouter(): Promise<void> {
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
        app: resolveApp(
          defineApp({
            routes: [
              route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
              route("/next", "./routes/next.tsx", { id: "next", render: "ssr" }),
            ],
          }),
        ),
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

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    fetchSpy = vi.fn().mockResolvedValue(createJsonResponse({ data: null }));
    vi.stubGlobal("fetch", fetchSpy);
    sessionStorage.clear();
    clearPrefetchCache();
    _resetNavigationForTesting();
    _resetBlockerForTesting();
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
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
    _resetNavigationForTesting();
    _resetBlockerForTesting();
  });

  it("stamps a history index on the entry it adopts and on every entry it pushes", async () => {
    await initRouter();
    expect(readHistoryIndex(history.state)).toBe(0);

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    expect(readHistoryIndex(history.state)).toBe(1);

    // A replace stays on the same rung of the stack.
    await window.__PRACHT_NAVIGATE__!("/", { replace: true });
    await flush();
    expect(readHistoryIndex(history.state)).toBe(1);
  });

  it("stops a push navigation before it aborts the page already on screen", async () => {
    await initRouter();
    registerBlocker(() => true);

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();

    expect(window.location.pathname).toBe("/");
    expect(root.textContent).toContain("home");
    // No route-state request either: blocking happens before the fetch starts.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getBlockerSnapshot()).toEqual({
      state: "blocked",
      location: NEXT_LOCATION,
    });
  });

  it("completes the original navigation when the guard proceeds", async () => {
    await initRouter();
    registerBlocker(() => true);

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    expect(window.location.pathname).toBe("/");

    proceedBlockedNavigation();
    await flush();
    await flush();

    expect(window.location.pathname).toBe("/next");
    expect(root.textContent).toContain("next");
    expect(getBlockerSnapshot()).toEqual({ state: "unblocked", location: null });
  });

  it("puts the history entry back when a traversal is refused", async () => {
    await initRouter();
    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    expect(readHistoryIndex(history.state)).toBe(1);

    registerBlocker(() => true);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    // What the browser does on Back: the entry (and URL) have already changed
    // by the time popstate fires.
    history.replaceState(withHistoryIndex(history.state, 0), "", "/");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));

    // Moved back one entry, so the correction moves forward one.
    expect(go).toHaveBeenCalledWith(1);
    expect(getBlockerSnapshot()).toMatchObject({
      state: "blocked",
      location: { pathname: "/" },
    });

    // Proceeding re-runs the traversal in the direction the user asked for.
    proceedBlockedNavigation();
    expect(go).toHaveBeenLastCalledWith(-1);
    go.mockRestore();
  });

  it("leaves a traversal onto an entry it never indexed unguarded", async () => {
    await initRouter();
    registerBlocker(() => true);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    // An entry pushed by app code carries no index, so the router cannot
    // measure the traversal — and an unmeasurable one cannot be put back.
    history.pushState(null, "", "/next");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await flush();

    expect(go).not.toHaveBeenCalled();
    expect(getBlockerSnapshot().state).toBe("unblocked");
    go.mockRestore();
  });

  it("does not re-prompt when a loader redirect continues an approved navigation", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith("/next")
        ? new Response(JSON.stringify({ redirect: "/" }), {
            headers: { "content-type": "application/json" },
          })
        : createJsonResponse({ data: null }),
    );
    await initRouter();

    const shouldBlock = vi.fn(() => true);
    registerBlocker(shouldBlock);

    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();
    proceedBlockedNavigation();
    await flush();
    await flush();

    // Once for the click the user approved — not again for the redirect the
    // server answered it with.
    expect(shouldBlock).toHaveBeenCalledTimes(1);
    expect(getBlockerSnapshot().state).toBe("unblocked");
  });
});
