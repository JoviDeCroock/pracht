// @vitest-environment jsdom
import { Component, h, render, type ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary, defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";
import { _resetNavigationForTesting } from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const app = resolveApp(
  defineApp({
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
      route("/crash", "./routes/crash.tsx", { id: "crash", render: "ssr" }),
    ],
  }),
);

function Crash(): never {
  throw new Error("window is not what it seems");
}

describe("client router: a render error without an app ErrorBoundary", () => {
  let root: HTMLDivElement;
  let reload: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

  async function initRouter(
    crashModule: Record<string, unknown>,
    options: Partial<Parameters<typeof initClientRouter>[0]> = {},
  ) {
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
          "./routes/crash.tsx": async () => crashModule,
        },
        shellModules: {},
        initialState: { data: null, routeId: "home", url: "/" },
        root,
        findModuleKey: (_modules, file) => file,
        ...options,
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
      vi.fn(
        async () =>
          new Response('{"data":null}', { headers: { "content-type": "application/json" } }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.clear();
    clearPrefetchCache();
    _resetNavigationForTesting();
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        get href() {
          return "http://localhost/";
        },
        hash: "",
        origin: "http://localhost",
        pathname: "/",
        search: "",
        reload,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
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

  it("reloads the page from the server instead of leaving the route area blank", async () => {
    await initRouter({ default: Crash });

    await window.__PRACHT_NAVIGATE__!("/crash");
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("renders the next page normally when the reload does not happen", async () => {
    // A `beforeunload` prompt the visitor cancels leaves the page in place.
    await initRouter({ default: Crash });

    await window.__PRACHT_NAVIGATE__!("/crash");
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    await window.__PRACHT_NAVIGATE__!("/");
    await flush();
    expect(root.textContent).toBe("home");
  });

  it("leaves a render error to an ErrorBoundary in the app root", async () => {
    await initRouter(
      { default: Crash },
      {
        rootModule: {
          Root: ({ children }: { children?: ComponentChildren }) =>
            h(ErrorBoundary, { fallback: h("p", null, "root caught") }, children),
        },
      },
    );

    await window.__PRACHT_NAVIGATE__!("/crash");
    await flush();

    expect(reload).not.toHaveBeenCalled();
    expect(root.textContent).toBe("root caught");
  });

  it("keeps the shell mounted across navigations", async () => {
    const shellMounts = vi.fn();
    const shellApp = resolveApp(
      defineApp({
        shells: { main: "./shells/main.tsx" },
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "main" }),
          route("/crash", "./routes/crash.tsx", { id: "crash", render: "ssr", shell: "main" }),
        ],
      }),
    );
    class Shell extends Component<{ children?: ComponentChildren }> {
      componentDidMount() {
        shellMounts();
      }
      render() {
        return h("div", null, this.props.children);
      }
    }
    root.innerHTML = "<div><main>home</main></div>";
    await initRouter(
      { default: () => h("main", null, "fine"), ErrorBoundary: () => h("p", null, "caught") },
      { app: shellApp, shellModules: { "./shells/main.tsx": async () => ({ Shell }) } },
    );
    await flush();
    shellMounts.mockClear();

    await window.__PRACHT_NAVIGATE__!("/crash");
    await flush();
    await window.__PRACHT_NAVIGATE__!("/");
    await flush();

    expect(root.textContent).toBe("home");
    expect(shellMounts).not.toHaveBeenCalled();
  });

  it("keeps the server markup when hydration throws, and reports the error", async () => {
    root.innerHTML = '<main>home <a href="/crash">crash</a></main><footer>end</footer>';
    const reported = vi.fn();
    vi.stubGlobal("reportError", reported);
    const BrowserOnlyCrash = () => {
      throw new Error("window is not what it seems");
    };

    await initClientRouter({
      app,
      routeModules: { "./routes/home.tsx": async () => ({ default: BrowserOnlyCrash }) },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules, file) => file,
    });
    await flush();

    expect(root.innerHTML).toBe('<main>home <a href="/crash">crash</a></main><footer>end</footer>');
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: "window is not what it seems" }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Hydration failed"));
    // The router stays out: links are plain document navigations.
    expect(window.__PRACHT_NAVIGATE__).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves a render error to the route's own ErrorBoundary", async () => {
    await initRouter({
      default: Crash,
      ErrorBoundary: ({ error }: { error: Error }) => h("p", null, `caught: ${error.message}`),
    });

    await window.__PRACHT_NAVIGATE__!("/crash");
    await flush();

    expect(reload).not.toHaveBeenCalled();
    expect(root.textContent).toBe("caught: window is not what it seems");
  });
});
