// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import { _resetNavigationForTesting } from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const app = resolveApp(
  defineApp({
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
      route("/a", "./routes/a.tsx", { id: "a", render: "ssr" }),
      route("/b", "./routes/b.tsx", { id: "b", render: "ssr" }),
    ],
  }),
);

describe("client router: route chunk failures", () => {
  let root: HTMLDivElement;
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

  async function initRouter(routeModules: Record<string, () => Promise<unknown>>) {
    const targets: EventTarget[] = [window, document];
    const originals = targets.map((target) => target.addEventListener.bind(target));
    targets.forEach((target, i) => {
      target.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject) => {
        listeners.push([target, type, handler]);
        originals[i](type, handler);
      }) as typeof target.addEventListener;
    });
    try {
      await initClientRouter({
        app,
        routeModules: {
          "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
          ...routeModules,
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
    root.innerHTML = "<main>home</main>";
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createJsonResponse({ data: null })),
    );
    sessionStorage.clear();
    clearPrefetchCache();
    _resetNavigationForTesting();
  });

  afterEach(() => {
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    listeners.length = 0;
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    _resetNavigationForTesting();
  });

  it("falls back to a document navigation and leaves history alone when the chunk 404s", async () => {
    let attempts = 0;
    await initRouter({
      "./routes/a.tsx": async () => {
        attempts++;
        if (attempts === 1) throw new TypeError("Failed to fetch dynamically imported module");
        return { default: () => h("main", null, "page a") };
      },
    });

    const originalLocation = window.location;
    const documentNavigations: string[] = [];
    const pushState = vi.spyOn(history, "pushState");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        get href() {
          return "http://localhost/";
        },
        set href(value: string) {
          documentNavigations.push(value);
        },
        hash: "",
        origin: "http://localhost",
        pathname: "/",
        search: "",
      },
    });
    try {
      await window.__PRACHT_NAVIGATE__!("/a");
      expect(documentNavigations).toEqual(["/a"]);
      expect(pushState).not.toHaveBeenCalled();
      expect(root.textContent).toBe("home");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }

    // The failed import is not cached: the next attempt loads the chunk again.
    await window.__PRACHT_NAVIGATE__!("/a");
    await flush();
    expect(attempts).toBe(2);
    expect(window.location.pathname).toBe("/a");
    expect(root.textContent).toBe("page a");
  });

  it("keeps the URL on the current page until the route module resolves", async () => {
    const chunkA = createDeferred<unknown>();
    await initRouter({
      "./routes/a.tsx": () => chunkA.promise,
      "./routes/b.tsx": async () => ({ default: () => h("main", null, "page b") }),
    });
    const lengthBefore = history.length;

    const first = window.__PRACHT_NAVIGATE__!("/a");
    await flush();
    expect(window.location.pathname).toBe("/");

    // A newer navigation supersedes the one still waiting for its chunk.
    await window.__PRACHT_NAVIGATE__!("/b");
    chunkA.resolve({ default: () => h("main", null, "page a") });
    await first;
    await flush();

    expect(window.location.pathname).toBe("/b");
    expect(root.textContent).toBe("page b");
    expect(history.length).toBe(lengthBefore + 1);
  });
});
