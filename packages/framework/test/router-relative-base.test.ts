// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/prefetch.ts", () => ({ setupPrefetching: vi.fn() }));

describe("relative anchor navigation under a deploy base", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/my-project/");
    window.scrollTo = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
  });

  it("resolves the href against the current base URL", async () => {
    vi.stubEnv("BASE_URL", "/my-project/");
    vi.resetModules();
    const [{ defineApp, resolveApp, route }, { initClientRouter }, hydration] = await Promise.all([
      import("../src/app.ts"),
      import("../src/router.ts"),
      import("../src/hydration.ts"),
    ]);
    hydration._resetForTesting();

    function Home() {
      return h("a", { href: "about" }, "About");
    }
    function About() {
      return h("main", null, "About page");
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", {
            id: "home",
            render: "ssg",
            hasHead: false,
            hasLoader: false,
          }),
          route("/about", "./routes/about.tsx", {
            id: "about",
            render: "ssg",
            hasHead: false,
            hasLoader: false,
          }),
        ],
      }),
    );
    root.innerHTML = '<a href="about">About</a>';

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: Home }),
        "./routes/about.tsx": async () => ({ default: About }),
      },
      shellModules: {},
      initialState: { data: undefined, routeId: "home", url: "/my-project/" },
      root,
      findModuleKey: (_modules: unknown, file: string) => file,
    });

    const anchor = root.querySelector("a")!;
    expect(anchor.href).toBe("http://localhost:3000/my-project/about");
    const click = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
    anchor.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(root.textContent).toBe("About page"));
    expect(window.location.pathname).toBe("/my-project/about");
  });
});
