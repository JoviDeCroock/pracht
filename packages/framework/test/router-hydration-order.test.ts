// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installOrder = vi.hoisted(() => [] as string[]);

vi.mock("../src/hydration-mismatch.ts", () => ({
  installHydrationMismatchWarning: vi.fn(() => installOrder.push("diagnostics")),
}));

import { defineApp, resolveApp, route } from "../src/app.ts";
import { _resetForTesting as resetHydrationForTesting } from "../src/hydration.ts";
import { initClientRouter } from "../src/router.ts";

describe("hydration diagnostics installation order", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    installOrder.length = 0;
    document.body.innerHTML = "";
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
    resetHydrationForTesting();
  });

  it("loads route modules before installing the dev Suspense tracker", async () => {
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

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => {
          installOrder.push("route");
          return { default: () => h("main", null, "Home") };
        },
      },
      shellModules: {},
      initialState: { data: undefined, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(installOrder).toEqual(["route", "diagnostics"]);
  });
});
