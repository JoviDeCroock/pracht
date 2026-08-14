// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime-static.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-static.ts")>();
  return { ...actual, IS_STATIC_TARGET: true };
});

import { defineApp, initClientRouter, resolveApp, route } from "../src/index.ts";

describe("static fallback router readiness", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
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
});
