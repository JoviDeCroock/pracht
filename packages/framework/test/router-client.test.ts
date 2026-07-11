// @vitest-environment jsdom
import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Form,
  Link,
  defineApp,
  initClientRouter,
  resolveApp,
  route,
  useLocation,
  useNavigate,
  useRevalidate,
  useRouteData,
} from "../src/index.ts";

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

describe("initClientRouter", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  it("renders shell-less SPA routes after the pending bootstrap fetch resolves", async () => {
    const app = resolveApp(
      defineApp({
        routes: [route("/settings", "./routes/settings.tsx", { render: "spa" })],
      }),
    );

    fetchSpy.mockResolvedValue(createJsonResponse({ data: { user: "Jovi" } }));

    await initClientRouter({
      app,
      routeModules: {
        "./routes/settings.tsx": async () => ({
          default: function Settings() {
            const data = useRouteData<{ user: string }>();
            return h("main", null, `Hello ${data.user}`);
          },
        }),
      },
      shellModules: {},
      initialState: {
        data: null,
        pending: true,
        routeId: "settings",
        url: "/settings",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/settings?_data=1",
      expect.objectContaining({
        headers: {},
        redirect: "manual",
      }),
    );
    expect(root.textContent).toContain("Hello Jovi");
  });

  it("renders typed links and navigates by route target objects", async () => {
    function Home() {
      const navigate = useNavigate();
      return h(
        "main",
        null,
        h(Link, { route: "product", params: { id: "1" }, search: { ref: "home" } }, "Product"),
        h(
          "button",
          {
            id: "go-product",
            onClick: () => navigate({ route: "product", params: { id: "2" } }),
          },
          "Go product",
        ),
      );
    }

    function Product() {
      const data = useRouteData<{ label: string }>();
      return h("main", null, data.label);
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route("/products/:id", "./routes/product.tsx", { id: "product", render: "ssr" }),
        ],
      }),
    );

    root.innerHTML =
      '<main><a href="/products/1?ref=home">Product</a><button id="go-product">Go product</button></main>';
    fetchSpy.mockResolvedValue(createJsonResponse({ data: { label: "Product 2" } }));

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: Home }),
        "./routes/product.tsx": async () => ({ default: Product }),
      },
      shellModules: {},
      initialState: {
        data: null,
        routeId: "home",
        url: "/",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(root.querySelector("a")?.getAttribute("href")).toBe("/products/1?ref=home");

    root.querySelector<HTMLButtonElement>("#go-product")?.click();
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/products/2",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(window.location.pathname).toBe("/products/2");
    expect(root.textContent).toContain("Product 2");
  });

  it("bypasses the HTTP cache when revalidating route data", async () => {
    function Dashboard() {
      const data = useRouteData<{ count: number }>();
      const revalidate = useRevalidate();
      return h(
        "main",
        null,
        h("span", { id: "count" }, String(data.count)),
        h("button", { id: "refresh", onClick: () => void revalidate() }, "Refresh"),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/dashboard", "./routes/dashboard.tsx", {
            id: "dashboard",
            loaderCache: 60,
            render: "ssr",
          }),
        ],
      }),
    );

    root.innerHTML = '<main><span id="count">1</span><button id="refresh">Refresh</button></main>';
    history.replaceState(null, "", "/dashboard");
    fetchSpy.mockResolvedValue(createJsonResponse({ data: { count: 2 } }));

    await initClientRouter({
      app,
      routeModules: {
        "./routes/dashboard.tsx": async () => ({ default: Dashboard }),
      },
      shellModules: {},
      initialState: {
        data: { count: 1 },
        routeId: "dashboard",
        url: "/dashboard",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/dashboard",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ "x-pracht-route-state-request": "1" }),
        redirect: "manual",
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves same-shell instances without exposing stale route data to useRouteData()", async () => {
    const renderLog: Array<{ label: string; pathname: string }> = [];
    let shellMountCount = 0;

    function SharedShell({ children }: { children: ComponentChildren }) {
      const [shellId] = useState(() => ++shellMountCount);
      return h("section", { "data-shell-id": String(shellId) }, children);
    }

    function Page() {
      const data = useRouteData<{ label: string }>();
      const { pathname } = useLocation();
      renderLog.push({ label: data.label, pathname });
      return h("div", { id: "page" }, data.label);
    }

    const app = resolveApp(
      defineApp({
        shells: {
          app: "./shells/app.tsx",
        },
        routes: [
          route("/", "./routes/home.tsx", { render: "ssr", shell: "app" }),
          route("/next", "./routes/next.tsx", { render: "ssr", shell: "app" }),
        ],
      }),
    );

    root.innerHTML = '<section data-shell-id="1"><div id="page">start</div></section>';
    history.replaceState(null, "", "/");

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/next") {
        return createJsonResponse({ data: { label: "next" } });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: Page }),
        "./routes/next.tsx": async () => ({ default: Page }),
      },
      shellModules: {
        "./shells/app.tsx": async () => ({ Shell: SharedShell }),
      },
      initialState: {
        data: { label: "start" },
        routeId: "home",
        url: "/",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    renderLog.length = 0;
    await window.__PRACHT_NAVIGATE__!("/next");
    await flush();

    expect(root.textContent).toContain("next");
    expect(root.querySelector("section")?.getAttribute("data-shell-id")).toBe("1");
    expect(shellMountCount).toBe(1);
    expect(renderLog).not.toContainEqual({
      label: "start",
      pathname: "/next",
    });
  });
});

describe("navigate() URL-scheme safety", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let hrefSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    hrefSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        get href() {
          return "http://localhost/";
        },
        set href(v: string) {
          hrefSpy(v);
        },
        replace: vi.fn(),
        assign: vi.fn(),
        origin: "http://localhost",
        pathname: "/",
        search: "",
        hash: "",
      },
    });

    const app = resolveApp(
      defineApp({ routes: [route("/", "./routes/home.tsx", { render: "ssr" })] }),
    );
    await initClientRouter({
      app,
      routeModules: { "./routes/home.tsx": async () => ({ default: () => null }) },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/" },
      root,
      findModuleKey: (_mods, file) => file,
    });
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  it("refuses javascript: URLs passed directly to __PRACHT_NAVIGATE__", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await window.__PRACHT_NAVIGATE__!("javascript:alert(1)");
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining("javascript:"));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/refused.*unsafe|unsafe.*url/i),
    );
    consoleError.mockRestore();
  });

  it("refuses data: URLs passed directly to __PRACHT_NAVIGATE__", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await window.__PRACHT_NAVIGATE__!("data:text/html,<script>alert(1)</script>");
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining("data:"));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/refused.*unsafe|unsafe.*url/i),
    );
    consoleError.mockRestore();
  });
});

describe("Form opaque-redirect safety", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let hrefSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    hrefSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        get href() {
          return "http://localhost/";
        },
        set href(v: string) {
          hrefSpy(v);
        },
        replace: vi.fn(),
        assign: vi.fn(),
        origin: "http://localhost",
        pathname: "/",
        search: "",
        hash: "",
      },
    });
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__PRACHT_NAVIGATE__;
    delete window.__PRACHT_ROUTER_READY__;
    delete globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  });

  it("does not assign javascript: action URL to window.location.href on opaque redirect", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate a redirect response with no Location header; the Form's status
    // check (>= 300 && < 400) covers both real opaqueredirects and plain 3xx.
    fetchSpy.mockResolvedValue(new Response(null, { status: 302 }));

    render(h(Form, { action: "javascript:alert(1)", method: "post" }), root);
    const form = root.querySelector("form")!;

    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining("javascript:"));
    consoleError.mockRestore();
  });
});
