// @vitest-environment jsdom
/**
 * A component that suspends needs a `<Suspense>` boundary somewhere above it.
 * Without one the thrown promise reaches the router's outermost boundary and
 * the page is left incomplete, which in development is reported by name.
 */
import { h, options, type ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineApp, resolveApp, route } from "../src/app.ts";
import { Suspense } from "../src/suspense.ts";
import { mountRouter, reply, settle, teardownRouterHarness } from "./router-harness.ts";

const app = resolveApp(
  defineApp({
    shells: { main: "./shells/main.tsx" },
    routes: [
      route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "main" }),
      route("/a", "./routes/a.tsx", { id: "a", render: "ssr", shell: "main" }),
    ],
  }),
);

const never = new Promise<void>(() => {});
function Suspends(): ComponentChildren {
  throw never;
}

/** Mount the home page and navigate to `/a`, whose page is `page`. */
async function navigateTo(page: () => ComponentChildren, shellBoundary: boolean) {
  const Shell = ({ children }: { children?: ComponentChildren }) =>
    h(
      "div",
      { id: "shell" },
      shellBoundary
        ? h(Suspense, { fallback: h("p", { id: "fallback" }, "loading") }, [children])
        : children,
    );
  const harness = await mountRouter({
    app,
    html: '<div id="shell"><main>home</main></div>',
    routeModules: {
      "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
      "./routes/a.tsx": async () => ({ default: page }),
    },
    shellModules: { "./shells/main.tsx": async () => ({ Shell }) },
    state: { "/a": reply.data(null) },
  });
  await harness.navigate("/a");
  await settle();
  return harness;
}

function diagnostics(harness: { errors: { mock: { calls: unknown[][] } } }): string[] {
  return harness.errors.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes("suspended with no <Suspense>"));
}

describe("client router: suspension without a boundary", () => {
  // The promise nothing handled escapes Preact's queued render. Run that
  // render inside a catch, so the escape is observed here instead of ending
  // the test run as an uncaught exception.
  const escaped: unknown[] = [];
  const debounceRendering = options.debounceRendering;

  beforeEach(() => {
    escaped.length = 0;
    options.debounceRendering = (process) => {
      queueMicrotask(() => {
        try {
          process();
        } catch (error) {
          escaped.push(error);
        }
      });
    };
  });

  afterEach(() => {
    teardownRouterHarness();
    options.debounceRendering = debounceRendering;
  });

  it("names the page and the fix when a route suspends with nothing above it", async () => {
    const harness = await navigateTo(Suspends, false);

    expect(diagnostics(harness)).toEqual([
      "[pracht] A component on /a suspended with no <Suspense> boundary above it, so the " +
        "page stays incomplete. Wrap it in <Suspense>, or load its data in the route loader.",
    ]);
    // What the message describes: the shell is up, the page is not.
    expect(harness.root.querySelector("#shell")).not.toBeNull();
    expect(harness.root.querySelector("main")).toBeNull();
    expect(escaped).toEqual([never]);
  });

  it("stays silent when a boundary above the route catches the suspension", async () => {
    const harness = await navigateTo(Suspends, true);

    expect(diagnostics(harness)).toEqual([]);
    expect(harness.root.querySelector("#fallback")?.textContent).toBe("loading");
    expect(escaped).toEqual([]);
  });

  it("stays silent for a route that renders without suspending", async () => {
    const harness = await navigateTo(() => h("main", null, "page a"), false);

    expect(diagnostics(harness)).toEqual([]);
    expect(harness.root.querySelector("main")?.textContent).toBe("page a");
    expect(escaped).toEqual([]);
  });
});
