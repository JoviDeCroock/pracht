// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime-static.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-static.ts")>();
  return { ...actual, IS_STATIC_TARGET: true };
});

vi.mock("../src/prefetch.ts", () => ({
  setupPrefetching: vi.fn(),
}));

import { defineApp, initClientRouter, resolveApp, route, useLocation } from "../src/index.ts";
import { _resetForTesting as resetHydrationForTesting } from "../src/hydration.ts";
import { _resetHydrationMismatchForTesting } from "../src/hydration-mismatch.ts";

describe("static fallback router readiness", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    document.documentElement.removeAttribute("data-pracht-hydrated");
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/items/42");
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
    document.documentElement.removeAttribute("data-pracht-hydrated");
    resetHydrationForTesting();
    _resetHydrationMismatchForTesting();
  });

  it("publishes readiness only after the fallback route commits", async () => {
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      markImportStarted = resolve;
    });

    const app = resolveApp(
      defineApp({
        routes: [
          route("/items/:id", "./routes/item.tsx", {
            hasLoader: false,
            id: "item",
            render: "spa",
          }),
        ],
      }),
    );

    const initialization = initClientRouter({
      app,
      routeModules: {
        "./routes/item.tsx": async () => {
          markImportStarted();
          await importGate;
          return { default: () => h("main", null, "Item 42") };
        },
      },
      shellModules: {},
      initialState: {
        data: undefined,
        error: null,
        fallback: true,
        pending: true,
        routeId: "__pracht_not_found__",
        url: "/",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    await importStarted;
    expect(window.__PRACHT_NAVIGATE__).toBeTypeOf("function");
    expect(window.__PRACHT_ROUTER_READY__).not.toBe(true);
    expect(document.documentElement.hasAttribute("data-pracht-hydrated")).toBe(false);

    releaseImport();
    await initialization;

    expect(root.textContent).toBe("Item 42");
    expect(window.__PRACHT_ROUTER_READY__).toBe(true);
    expect(document.documentElement.getAttribute("data-pracht-hydrated")).toBe("true");

    // Let the router's lazy prefetch setup and Preact's scheduled effects
    // settle before Vitest tears down the jsdom globals.
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

  it("clears stale route fonts when a dynamic SPA state file is absent", async () => {
    history.replaceState(null, "", "/");
    root.innerHTML = "<main>Home</main>";
    document.head.innerHTML =
      '<link data-pracht-font-preload rel="preload" as="font" href="/old.woff2"><style data-pracht-fonts>@font-face{font-family:"Old"}</style>';
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("missing route state"));

    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssg", hasHead: true }),
          route("/items/:id", "./routes/item.tsx", {
            hasLoader: false,
            hasHead: true,
            id: "item",
            render: "spa",
          }),
        ],
      }),
    );

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: () => h("main", null, "Home") }),
        "./routes/item.tsx": async () => ({ default: () => h("main", null, "Item 42") }),
      },
      shellModules: {},
      initialState: { data: undefined, error: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules, file) => file,
    });

    await window.__PRACHT_NAVIGATE__!("/items/42");

    expect(root.textContent).toBe("Item 42");
    expect(document.head.querySelector("link[data-pracht-font-preload]")).toBeNull();
    expect(document.head.querySelector("style[data-pracht-fonts]")).toBeNull();
  });

  it("hydrates static not-found HTML before adopting the requested URL", async () => {
    history.replaceState(null, "", "/actually-missing");
    root.innerHTML = "<main><p>synthetic path</p></main>";
    const renderedPaths: string[] = [];

    function NotFound() {
      const { pathname } = useLocation();
      renderedPaths.push(pathname);
      return h(
        "main",
        null,
        pathname === "/404.html"
          ? h("p", null, "synthetic path")
          : h("section", null, "actual path"),
      );
    }

    const app = resolveApp(
      defineApp({
        notFound: "./routes/not-found.tsx",
        routes: [],
      }),
    );

    await initClientRouter({
      app,
      routeModules: {
        "./routes/not-found.tsx": async () => ({ default: NotFound }),
      },
      shellModules: {},
      initialState: {
        data: undefined,
        error: null,
        routeId: "__pracht_not_found__",
        url: "/404.html",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(renderedPaths[0]).toBe("/404.html");
    expect(renderedPaths.at(-1)).toBe("/actually-missing");
    expect(root.textContent).toBe("actual path");
    expect(document.querySelector("#__pracht_hydration_mismatch__")).toBeNull();
  });

  it("renders the not-found error boundary from fallback state", async () => {
    history.replaceState(null, "", "/actually-missing");

    const app = resolveApp(
      defineApp({
        notFound: "./routes/not-found.tsx",
        routes: [],
      }),
    );

    await initClientRouter({
      app,
      routeModules: {
        "./routes/not-found.tsx": async () => ({
          default: () => h("main", null, "ordinary not found"),
          ErrorBoundary: ({ error }: { error: Error }) =>
            h("main", null, `handled: ${error.message}`),
        }),
      },
      shellModules: {},
      initialState: {
        data: undefined,
        error: {
          message: "not-found loader rejected the path",
          name: "PrachtHttpError",
          status: 404,
        },
        fallback: true,
        pending: true,
        routeId: "__pracht_not_found__",
        url: "/",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(root.textContent).toBe("handled: not-found loader rejected the path");
  });
});
