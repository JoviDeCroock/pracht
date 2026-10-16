// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadRouter(policy: "ignore" | "always" | "never") {
  vi.resetModules();
  vi.stubGlobal("__PRACHT_TRAILING_SLASH__", policy);
  const [core, hydration] = await Promise.all([
    import("../src/index.ts"),
    import("../src/hydration.ts"),
  ]);
  hydration._resetForTesting();
  return core;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("client navigation under pracht({ trailingSlash })", () => {
  let root: HTMLDivElement;
  const fetchMock = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: null }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
  });

  async function boot(policy: "ignore" | "always" | "never") {
    const core = await loadRouter(policy);
    const app = core.resolveApp(
      core.defineApp({
        routes: [
          core.route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          core.route("/about", "./routes/about.tsx", { id: "about", render: "ssr" }),
        ],
      }),
    );
    const Page = (label: string) => () => h("main", null, label);
    await core.initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: Page("home") }),
        "./routes/about.tsx": async () => ({ default: Page("about") }),
      },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_modules: unknown, file: string) => file,
    });
    await flush();
    return core;
  }

  it('lands a hand-written "/about" on "/about/" under "always"', async () => {
    await boot("always");
    await window.__PRACHT_NAVIGATE__!("/about?tab=1#team");
    await flush();
    expect(window.location.pathname).toBe("/about/");
    expect(window.location.search).toBe("?tab=1");
    expect(window.location.hash).toBe("#team");
    expect(root.textContent).toBe("about");
    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested.some((url) => url.startsWith("/about/?tab=1"))).toBe(true);
  });

  it('drops the slash under "never"', async () => {
    await boot("never");
    await window.__PRACHT_NAVIGATE__!("/about/");
    await flush();
    expect(window.location.pathname).toBe("/about");
  });

  it("keeps the URL as written by default", async () => {
    await boot("ignore");
    await window.__PRACHT_NAVIGATE__!("/about/");
    await flush();
    expect(window.location.pathname).toBe("/about/");
  });
});
