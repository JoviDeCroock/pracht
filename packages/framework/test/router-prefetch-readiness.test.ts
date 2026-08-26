// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/prefetch.ts", () => {
  throw new Error("prefetch chunk failed to load");
});

import { defineApp, resolveApp, route } from "../src/app.ts";
import { _resetForTesting as resetHydrationForTesting } from "../src/hydration.ts";
import { _resetHydrationMismatchForTesting } from "../src/hydration-mismatch.ts";
import { initClientRouter } from "../src/router.ts";

describe("router readiness without prefetching", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-pracht-hydrated");
    root = document.createElement("div");
    root.innerHTML = "<main>Home</main>";
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
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

  it("publishes readiness when the optional prefetch chunk fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", {
            hasHead: false,
            hasLoader: false,
            id: "home",
            render: "ssr",
          }),
        ],
      }),
    );

    await expect(
      initClientRouter({
        app,
        routeModules: {
          "./routes/home.tsx": async () => ({ default: () => h("main", null, "Home") }),
        },
        shellModules: {},
        initialState: { data: undefined, routeId: "home", url: "/" },
        root,
        findModuleKey: (_modules, file) => file,
      }),
    ).resolves.toBeUndefined();

    expect(window.__PRACHT_ROUTER_READY__).toBe(true);
    expect(document.documentElement.getAttribute("data-pracht-hydrated")).toBe("true");
    expect(warning).toHaveBeenCalledWith(
      "[pracht] Prefetching could not be initialized.",
      expect.any(Error),
    );
  });
});
