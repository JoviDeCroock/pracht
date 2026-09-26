import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defer,
  defineApp,
  handlePrachtRequest,
  notFound,
  redirect,
  route,
  useRouteData,
  useShellData,
} from "../src/index.ts";
import { fetchPrachtRouteState, routeNeedsServerFetch } from "../src/runtime-client-fetch.ts";
import { SHELL_DATA_REQUEST_HEADER } from "../src/runtime-constants.ts";
import {
  getCachedRouteState,
  cacheRouteState,
  clearPrefetchCache,
  routeStateCacheKey,
} from "../src/prefetch-cache.ts";
import type { LoaderArgs, ModuleRegistry, ResolvedRoute, ShellModule } from "../src/types.ts";

const ROUTE_STATE = { "x-pracht-route-state-request": "1" };

function parseHydrationState(html: string): Record<string, unknown> {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

interface Fixture {
  shell?: Partial<ShellModule>;
  routeLoader?: (args: LoaderArgs) => unknown;
  routeExtras?: Record<string, unknown>;
  render?: "ssr" | "spa" | "ssg";
  hydration?: "full" | "islands" | "none";
}

function createFixture(fixture: Fixture = {}) {
  const shellLoader = vi.fn(async (_args: LoaderArgs) => ({ user: "Ada" }));
  const app = defineApp({
    shells: { app: "./shells/app.tsx", public: "./shells/public.tsx" },
    routes: [
      route("/dashboard", "./routes/dashboard.tsx", {
        id: "dashboard",
        shell: "app",
        render: fixture.render ?? "ssr",
        hydration: fixture.hydration,
      }),
      route("/about", "./routes/about.tsx", { id: "about", shell: "public", render: "ssr" }),
    ],
  });

  function RouteView() {
    const shell = useShellData<{ user: string }>();
    const data = useRouteData<{ projects: number } | undefined>();
    return h("section", { class: "route" }, `route:${shell?.user}:${data?.projects}`);
  }

  function ShellView({ children }: { children: preact.ComponentChildren }) {
    const shell = useShellData("app") as { user: string } | undefined;
    return h("div", { class: "shell" }, h("nav", null, `shell:${shell?.user}`), children);
  }

  const registry: ModuleRegistry = {
    routeModules: {
      "./routes/dashboard.tsx": async () => ({
        Component: RouteView,
        loader: fixture.routeLoader ?? (async () => ({ projects: 3 })),
        ...fixture.routeExtras,
      }),
      "./routes/about.tsx": async () => ({ Component: () => h("p", null, "about") }),
    },
    shellModules: {
      "./shells/app.tsx": async () => ({
        Shell: ShellView as ShellModule["Shell"],
        loader: shellLoader,
        ...fixture.shell,
      }),
      "./shells/public.tsx": async () => ({
        Shell: ({ children }) => h("div", { class: "public" }, children),
      }),
    },
  };

  const request = (path: string, headers?: Record<string, string>) =>
    handlePrachtRequest({
      app,
      debugErrors: true,
      registry,
      request: new Request(`http://localhost${path}`, { headers }),
    });

  return { app, registry, request, shellLoader };
}

describe("shell loaders on the server", () => {
  it("renders shell data in the shell and the route, and serializes it for hydration", async () => {
    const { request, shellLoader } = createFixture();

    const response = await request("/dashboard");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(shellLoader).toHaveBeenCalledTimes(1);
    expect(html).toContain("shell:Ada");
    expect(html).toContain("route:Ada:3");
    expect(parseHydrationState(html)).toMatchObject({
      data: { projects: 3 },
      shellData: { user: "Ada" },
    });
  });

  it("omits shellData from hydration state when the shell has no loader", async () => {
    const { request } = createFixture({ shell: { loader: undefined } });

    const html = await (await request("/dashboard")).text();

    expect(parseHydrationState(html)).not.toHaveProperty("shellData");
    expect(html).toContain("shell:undefined");
  });

  it("runs the shell and route loaders concurrently, after middleware", async () => {
    let releaseShell!: () => void;
    const shellStarted = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    let routeStarted = false;
    const { request } = createFixture({
      shell: {
        loader: async () => {
          releaseShell();
          // The route loader has to have started too, or this never resolves.
          await vi.waitFor(() => expect(routeStarted).toBe(true));
          return { user: "Ada" };
        },
      },
      routeLoader: async () => {
        routeStarted = true;
        await shellStarted;
        return { projects: 3 };
      },
    });

    const response = await request("/dashboard");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("route:Ada:3");
  });

  it("hands the shell loader the route's LoaderArgs", async () => {
    const { request, shellLoader } = createFixture();

    await request("/dashboard?tab=1");

    const args = shellLoader.mock.calls[0]![0];
    expect(args.url.pathname).toBe("/dashboard");
    expect(args.route.id).toBe("dashboard");
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.request).toBeInstanceOf(Request);
  });

  it("includes shell data in the route-state response and varies on the claim header", async () => {
    const { request } = createFixture();

    const response = await request("/dashboard", ROUTE_STATE);

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toContain(SHELL_DATA_REQUEST_HEADER);
    await expect(response.json()).resolves.toMatchObject({
      data: { projects: 3 },
      shellData: { user: "Ada" },
    });
  });

  it("skips the shell loader when the client already holds that shell's data", async () => {
    const { request, shellLoader } = createFixture();

    const response = await request("/dashboard", {
      ...ROUTE_STATE,
      [SHELL_DATA_REQUEST_HEADER]: "app",
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(shellLoader).not.toHaveBeenCalled();
    expect(body.data).toEqual({ projects: 3 });
    expect(body).not.toHaveProperty("shellData");
  });

  it("runs the shell loader when the claimed shell is not the route's", async () => {
    const { request, shellLoader } = createFixture();

    const response = await request("/dashboard", {
      ...ROUTE_STATE,
      [SHELL_DATA_REQUEST_HEADER]: "public",
    });

    expect(shellLoader).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ shellData: { user: "Ada" } });
  });

  it("ignores the claim on document requests", async () => {
    const { request, shellLoader } = createFixture();

    const html = await (await request("/dashboard", { [SHELL_DATA_REQUEST_HEADER]: "app" })).text();

    expect(shellLoader).toHaveBeenCalledTimes(1);
    expect(parseHydrationState(html)).toMatchObject({ shellData: { user: "Ada" } });
  });

  it("follows a redirect returned or thrown by the shell loader", async () => {
    const { request } = createFixture({
      shell: {
        loader: async () => {
          throw redirect("/login");
        },
      },
    });

    const document = await request("/dashboard");
    expect(document.status).toBe(302);
    expect(document.headers.get("location")).toBe("/login");

    const state = await request("/dashboard", ROUTE_STATE);
    await expect(state.json()).resolves.toEqual({ redirect: "/login" });
  });

  it("lets the shell's outcome win when both loaders answer", async () => {
    const { request } = createFixture({
      shell: {
        loader: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return redirect("/login");
        },
      },
      routeLoader: async () => {
        throw new Error("route exploded");
      },
    });

    const response = await request("/dashboard");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("renders the shell ErrorBoundary and attributes the failure to the shell loader", async () => {
    const onRouteError = vi.fn();
    const { app, registry } = createFixture({
      shell: {
        loader: async () => {
          throw new Error("shell exploded");
        },
        ErrorBoundary: ({ error }) => h("p", null, `Shell error: ${error.message}`),
      },
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      onRouteError,
      registry,
      request: new Request("http://localhost/dashboard"),
    });
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(html).toContain("Shell error: shell exploded");
    // The shell renders around its boundary without data it failed to load.
    expect(html).toContain("shell:undefined");
    expect(parseHydrationState(html)).not.toHaveProperty("shellData");
    expect(onRouteError.mock.calls[0]![2]).toMatchObject({
      loaderFile: "./shells/app.tsx",
      phase: "loader",
    });
  });

  it("keeps shell data on route loader errors", async () => {
    const { request } = createFixture({
      routeLoader: async () => {
        throw new Error("route exploded");
      },
      routeExtras: {
        ErrorBoundary: ({ error }: { error: Error }) =>
          h("p", null, `Route error: ${error.message}`),
      },
    });

    const document = await request("/dashboard");
    const html = await document.text();
    expect(document.status).toBe(500);
    expect(html).toContain("shell:Ada");
    expect(html).toContain("Route error: route exploded");
    expect(parseHydrationState(html)).toMatchObject({ shellData: { user: "Ada" } });

    const state = await request("/dashboard", ROUTE_STATE);
    expect(state.status).toBe(500);
    await expect(state.json()).resolves.toMatchObject({
      error: { message: "route exploded" },
      shellData: { user: "Ada" },
    });
  });

  it("treats notFound() from the shell loader like one from the route loader", async () => {
    const { request } = createFixture({
      shell: {
        loader: async () => {
          throw notFound();
        },
      },
    });

    const response = await request("/dashboard", ROUTE_STATE);

    expect(response.status).toBe(404);
  });

  it("renders the SPA loading state without shell data and asks the client to fetch it", async () => {
    const { request } = createFixture({
      render: "spa",
      routeLoader: undefined,
      routeExtras: { loader: undefined },
      shell: { Loading: () => h("p", null, "Loading...") },
    });

    const html = await (await request("/dashboard")).text();
    const state = parseHydrationState(html);

    expect(html).toContain("shell:undefined");
    expect(html).toContain("Loading...");
    expect(state).toMatchObject({ pending: true });
    expect(state).not.toHaveProperty("shellData");
    expect(html).toContain('href="/dashboard?_data=1"');
  });

  it("renders shell data into islands documents without hydration state", async () => {
    const { request } = createFixture({ hydration: "islands" });

    const html = await (await request("/dashboard")).text();

    expect(html).toContain("shell:Ada");
    expect(html).not.toContain('id="pracht-state"');
  });

  it("resolves deferred values in shell data", async () => {
    const { request } = createFixture({
      shell: { loader: async () => ({ user: defer(Promise.resolve("Ada")) }) },
    });

    const response = await request("/dashboard", ROUTE_STATE);

    await expect(response.json()).resolves.toMatchObject({ shellData: { user: "Ada" } });
  });
});

describe("shell data on the client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPrefetchCache();
  });

  it("claims the held shell and reports whether the response carried its data", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: 1, shellData: { user: "Ada" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const withShell = await fetchPrachtRouteState("/dashboard", { heldShell: "app" });
    expect(withShell).toMatchObject({ type: "data", data: 1, shell: { data: { user: "Ada" } } });
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)[SHELL_DATA_REQUEST_HEADER]).toBe("app");

    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ data: 2 }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const withoutShell = await fetchPrachtRouteState("/dashboard");
    expect(withoutShell).toMatchObject({ type: "data", data: 2 });
    expect((withoutShell as { shell?: unknown }).shell).toBeUndefined();
    const plainInit = (fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(plainInit.headers as Record<string, string>).not.toHaveProperty(
      SHELL_DATA_REQUEST_HEADER,
    );
  });

  it("keeps route state fetched under a claim apart from unclaimed route state", () => {
    const claimed = Promise.resolve({ type: "data" as const, data: 1 });
    cacheRouteState(routeStateCacheKey("/dashboard", "app"), claimed);

    expect(getCachedRouteState(routeStateCacheKey("/dashboard", "app"))).toBe(claimed);
    expect(getCachedRouteState(routeStateCacheKey("/dashboard"))).toBeNull();
  });

  it("skips the fetch for a loaderless route only while its shell's data is held", () => {
    const route = {
      hasHead: false,
      hasLoader: false,
      hasShellLoader: true,
      middlewareFiles: [],
      path: "/about",
      segments: [],
      shell: "app",
      file: "./routes/about.tsx",
    } as unknown as ResolvedRoute;

    expect(routeNeedsServerFetch(route)).toBe(true);
    expect(routeNeedsServerFetch(route, true)).toBe(false);
    expect(routeNeedsServerFetch({ ...route, hasShellLoader: false })).toBe(false);
  });
});
