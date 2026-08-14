// @vitest-environment jsdom
import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Form,
  Link,
  Suspense,
  defineApp,
  initClientRouter,
  resolveApp,
  route,
  useLocation,
  useNavigate,
  useRevalidate,
  useRouteData,
  useSearchParams,
} from "../src/index.ts";
import { _resetForTesting } from "../src/hydration.ts";

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
    _resetForTesting();
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
    history.replaceState(null, "", "/settings");
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

  it("publishes the visitor query after hydrating with prerendered route state", async () => {
    history.replaceState(null, "", "/products?lang=zh&example=router#details");
    const observedLanguages: Array<string | null> = [];

    function Products({ data }: { data: { label: string } }) {
      const searchParams = useSearchParams();
      const language = searchParams.get("lang");
      observedLanguages.push(language);
      return h(
        "main",
        null,
        language === "zh" ? h("span", null, `${data.label}: zh`) : `${data.label}: en`,
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/products", "./routes/products.tsx", {
            id: "products",
            render: "ssg",
          }),
        ],
      }),
    );

    root.innerHTML = "<main>prerendered: en</main>";

    await initClientRouter({
      app,
      routeModules: {
        "./routes/products.tsx": async () => ({ default: Products }),
      },
      shellModules: {},
      initialState: {
        data: { label: "prerendered" },
        routeId: "products",
        url: "/products",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(observedLanguages[0]).toBeNull();
    await flush();
    expect(root.textContent).toBe("prerendered: zh");
    expect(observedLanguages).toContain("zh");
    expect(document.getElementById("__pracht_hydration_mismatch__")).toBeNull();
    expect(window.location.hash).toBe("#details");
  });

  it("preserves revalidated data when publishing the visitor query after Suspense hydration", async () => {
    history.replaceState(null, "", "/dashboard?lang=zh");
    let resolveSuspense!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSuspense = resolve;
    });
    let suspended = false;

    function LazyChild() {
      if (!suspended) {
        suspended = true;
        throw pending;
      }
      return h("div", null, "ready");
    }

    function Dashboard() {
      const data = useRouteData<{ count: number }>();
      const revalidate = useRevalidate();
      const searchParams = useSearchParams();
      return h(
        "main",
        null,
        h("span", { id: "count" }, String(data.count)),
        h("span", { id: "lang" }, searchParams.get("lang") ?? "none"),
        h("button", { id: "refresh", onClick: () => void revalidate() }, "Refresh"),
        h(Suspense as any, { fallback: null }, h(LazyChild, null)),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/dashboard", "./routes/dashboard.tsx", {
            id: "dashboard",
            render: "ssg",
          }),
        ],
      }),
    );

    root.innerHTML =
      '<main><span id="count">1</span><span id="lang">none</span><button id="refresh">Refresh</button><div>ready</div></main>';
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

    root.querySelector<HTMLButtonElement>("#refresh")!.click();
    await flush();
    expect(root.querySelector("#count")?.textContent).toBe("2");

    resolveSuspense();
    await flush();
    await flush();

    expect(root.querySelector("#lang")?.textContent).toBe("zh");
    expect(root.querySelector("#count")?.textContent).toBe("2");
  });

  it("does not publish an in-flight destination query into the previous route", async () => {
    history.replaceState(null, "", "/dashboard");
    let resolveSuspense!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSuspense = resolve;
    });
    let suspended = false;

    function LazyChild() {
      if (!suspended) {
        suspended = true;
        throw pending;
      }
      return h("div", null, "ready");
    }

    function Home() {
      const searchParams = useSearchParams();
      return h(
        "main",
        null,
        h("span", { id: "page" }, `home:${searchParams.get("lang") ?? "none"}`),
        h(Suspense as any, { fallback: null }, h(LazyChild, null)),
      );
    }

    function Next() {
      const searchParams = useSearchParams();
      return h(
        "main",
        null,
        h("span", { id: "page" }, `next:${searchParams.get("lang") ?? "none"}`),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/dashboard", "./routes/dashboard.tsx", { id: "home", render: "ssg" }),
          route("/next", "./routes/next.tsx", { id: "next", render: "ssg" }),
        ],
      }),
    );
    let releaseNextModule!: () => void;
    const nextModule = new Promise<{ default: typeof Next }>((resolve) => {
      releaseNextModule = () => resolve({ default: Next });
    });

    root.innerHTML = '<main><span id="page">home:none</span><div>ready</div></main>';
    fetchSpy.mockResolvedValue(createJsonResponse({ data: null }));
    await initClientRouter({
      app,
      routeModules: {
        "./routes/dashboard.tsx": async () => ({ default: Home }),
        "./routes/next.tsx": () => nextModule,
      },
      shellModules: {},
      initialState: { data: null, routeId: "home", url: "/dashboard" },
      root,
      findModuleKey: (_modules, file) => file,
    });

    const navigation = window.__PRACHT_NAVIGATE__!("/next?lang=fr");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(window.location.pathname).toBe("/next");

    resolveSuspense();
    await flush();
    await flush();
    expect(root.querySelector("#page")?.textContent).toBe("home:none");

    releaseNextModule();
    await navigation;
    await flush();
    expect(root.querySelector("#page")?.textContent).toBe("next:fr");
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
        cache: "reload",
        headers: expect.objectContaining({ "x-pracht-route-state-request": "1" }),
        redirect: "manual",
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes the route component's data prop when route data revalidates", async () => {
    // `RouteComponentProps` is what `create-pracht` and `pracht generate route`
    // emit, so the prop has to track revalidation exactly like `useRouteData()`.
    function Dashboard({ data }: { data: { count: number } }) {
      const hookData = useRouteData<{ count: number }>();
      const revalidate = useRevalidate();
      return h(
        "main",
        null,
        h("span", { id: "prop-count" }, String(data.count)),
        h("span", { id: "hook-count" }, String(hookData.count)),
        h("button", { id: "refresh", onClick: () => void revalidate() }, "Refresh"),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
      }),
    );

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

    expect(root.querySelector("#prop-count")?.textContent).toBe("1");
    expect(root.querySelector("#hook-count")?.textContent).toBe("1");

    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await flush();
    await flush();

    expect(root.querySelector("#hook-count")?.textContent).toBe("2");
    expect(root.querySelector("#prop-count")?.textContent).toBe("2");
  });

  it("discards a revalidation that settles after navigating away", async () => {
    // A revalidation started on one route must never publish its result as the
    // next route's data — not through `useRouteData()` and not through the
    // `data` prop.
    function Dashboard({ data }: { data: { label: string } }) {
      const revalidate = useRevalidate();
      const navigate = useNavigate();
      return h(
        "main",
        null,
        h("span", { id: "label" }, data.label),
        h("button", { id: "refresh", onClick: () => void revalidate() }, "Refresh"),
        h("button", { id: "to-settings", onClick: () => void navigate("/settings") }, "Settings"),
      );
    }

    function Settings({ data }: { data: { label: string } }) {
      return h("main", null, h("span", { id: "label" }, data.label));
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" }),
          route("/settings", "./routes/settings.tsx", { id: "settings", render: "ssr" }),
        ],
      }),
    );

    root.innerHTML =
      '<main><span id="label">DASHBOARD-1</span><button id="refresh">Refresh</button>' +
      '<button id="to-settings">Settings</button></main>';
    history.replaceState(null, "", "/dashboard");

    let releaseDashboardRevalidation!: () => void;
    const heldDashboardRevalidation = new Promise<Response>((resolve) => {
      releaseDashboardRevalidation = () =>
        resolve(createJsonResponse({ data: { label: "DASHBOARD-2" } }));
    });

    fetchSpy.mockImplementation((input: string) =>
      input.startsWith("/settings")
        ? Promise.resolve(createJsonResponse({ data: { label: "SETTINGS" } }))
        : heldDashboardRevalidation,
    );

    await initClientRouter({
      app,
      routeModules: {
        "./routes/dashboard.tsx": async () => ({ default: Dashboard }),
        "./routes/settings.tsx": async () => ({ default: Settings }),
      },
      shellModules: {},
      initialState: {
        data: { label: "DASHBOARD-1" },
        routeId: "dashboard",
        url: "/dashboard",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await flush();

    root.querySelector<HTMLButtonElement>("#to-settings")?.click();
    await flush();
    await flush();
    expect(root.querySelector("#label")?.textContent).toBe("SETTINGS");

    releaseDashboardRevalidation();
    await flush();
    await flush();

    expect(root.querySelector("#label")?.textContent).toBe("SETTINGS");
  });

  it("keeps the error prop when an error boundary renders", async () => {
    // Error and SPA-pending states pass props without loader data; the runtime
    // must not graft `data` onto them.
    function Boom() {
      return h("main", null, "never");
    }

    function ErrorBoundary(props: { error: Error }) {
      return h(
        "main",
        null,
        h("span", { id: "message" }, props.error.message),
        h("span", { id: "prop-keys" }, Object.keys(props).sort().join(",")),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [route("/boom", "./routes/boom.tsx", { id: "boom", render: "ssr" })],
      }),
    );

    history.replaceState(null, "", "/boom");

    await initClientRouter({
      app,
      routeModules: {
        "./routes/boom.tsx": async () => ({ ErrorBoundary, default: Boom }),
      },
      shellModules: {},
      initialState: {
        data: null,
        error: { message: "loader exploded", name: "Error", status: 500 },
        routeId: "boom",
        url: "/boom",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    expect(root.querySelector("#message")?.textContent).toBe("loader exploded");
    expect(root.querySelector("#prop-keys")?.textContent).toBe("error");
  });

  it("bypasses the HTTP cache when a form redirect reloads cached route data", async () => {
    function Cart() {
      const data = useRouteData<{ count: number }>();
      return h(
        "main",
        null,
        h(Form, { action: "/api/cart", method: "post" }, h("button", null, "Add")),
        h("span", { id: "count" }, String(data.count)),
      );
    }

    const app = resolveApp(
      defineApp({
        routes: [
          route("/cart", "./routes/cart.tsx", {
            id: "cart",
            loaderCache: 60,
            render: "ssr",
          }),
        ],
      }),
    );

    root.innerHTML =
      '<main><form action="/api/cart" method="post"><button>Add</button></form><span id="count">1</span></main>';
    history.replaceState(null, "", "/cart");
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/cart") {
        return new Response(null, { headers: { location: "/cart" }, status: 302 });
      }

      return createJsonResponse({ data: { count: 2 } });
    });

    await initClientRouter({
      app,
      routeModules: {
        "./routes/cart.tsx": async () => ({ default: Cart }),
      },
      shellModules: {},
      initialState: {
        data: { count: 1 },
        routeId: "cart",
        url: "/cart",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    root.querySelector("form")?.dispatchEvent(submitEvent);
    await flush();
    await flush();

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/cart",
      expect.objectContaining({
        cache: "reload",
        headers: expect.objectContaining({ "x-pracht-route-state-request": "1" }),
        redirect: "manual",
      }),
    );
    expect(root.querySelector("#count")?.textContent).toBe("2");
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

  it("hydrates the app notFound page at a url that matches no route", async () => {
    const app = resolveApp(
      defineApp({
        routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr" })],
        notFound: "./routes/not-found.tsx",
      }),
    );

    function NotFound() {
      const [clicked, setClicked] = useState(false);
      return h(
        "main",
        null,
        h("button", { id: "retry", onClick: () => setClicked(true) }, "Retry"),
        clicked ? "clicked" : "not clicked",
      );
    }

    history.replaceState(null, "", "/missing");
    root.innerHTML = '<main><button id="retry">Retry</button>not clicked</main>';

    await initClientRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
        "./routes/not-found.tsx": async () => ({ default: NotFound }),
      },
      shellModules: {},
      initialState: {
        data: null,
        routeId: "__pracht_not_found__",
        url: "/missing",
      },
      root,
      findModuleKey: (_modules, file) => file,
    });

    // Hydrated, so the page's own interactivity works.
    root.querySelector<HTMLButtonElement>("#retry")!.click();
    await flush();
    expect(root.textContent).toContain("clicked");
  });

  it("uses a document navigation for loader 404s instead of a shell boundary", async () => {
    const app = resolveApp(
      defineApp({
        shells: { public: "./shells/public.tsx" },
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route("/posts/:slug", "./routes/post.tsx", {
            id: "post",
            render: "ssr",
            shell: "public",
          }),
        ],
        notFound: "./routes/not-found.tsx",
      }),
    );
    const originalLocation = window.location;
    const documentNavigations: string[] = [];
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
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
      root.innerHTML = "<main>home</main>";
      fetchSpy.mockResolvedValue(
        createJsonResponse(
          {
            error: {
              message: "Post not found",
              name: "PrachtHttpError",
              status: 404,
            },
          },
          { status: 404 },
        ),
      );

      await initClientRouter({
        app,
        routeModules: {
          "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
          "./routes/post.tsx": async () => ({ default: () => h("main", null, "post") }),
          "./routes/not-found.tsx": async () => ({ default: () => h("main", null, "404") }),
        },
        shellModules: {
          "./shells/public.tsx": async () => ({
            Shell: ({ children }: { children: ComponentChildren }) => h("section", null, children),
            ErrorBoundary: () => h("p", null, "shell boundary"),
          }),
        },
        initialState: {
          data: null,
          routeId: "home",
          url: "/",
        },
        root,
        findModuleKey: (_modules, file) => file,
      });

      await window.__PRACHT_NAVIGATE__!("/posts/missing");

      expect(documentNavigations).toEqual(["/posts/missing"]);
      expect(root.textContent).not.toContain("shell boundary");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
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
