import { createContext, h } from "preact";
import type { ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  describeRouteErrorModule,
  handlePrachtRequest,
  PrachtHttpError,
  route,
  type LoaderArgs,
  type RootModule,
  type RouteErrorContext,
  type RootSetupArgs,
} from "../src/index.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";
import { fetchPrachtRouteState, setRootSnapshotHandler } from "../src/runtime-client-fetch.ts";

interface RootState {
  id: number;
  seen: string[];
}

const RootContext = createContext<RootState | null>(null);

function createRootModule(): RootModule<RootState> & { setupCalls: RootSetupArgs[] } {
  let nextId = 0;
  const setupCalls: RootSetupArgs[] = [];
  return {
    setupCalls,
    setup(args) {
      setupCalls.push(args);
      return { id: ++nextId, seen: [] };
    },
    Root({ state, children }) {
      return h(RootContext.Provider, { value: state }, children);
    },
    dehydrate(state) {
      return state.seen.length > 0 ? { id: state.id, seen: state.seen } : undefined;
    },
  };
}

function ReadsRoot() {
  const state = useContext(RootContext);
  return h("p", { id: "root-id" }, state ? `root-${state.id}` : "no-root");
}

function parseHydrationState(html: string): Record<string, unknown> {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

const shellModules = {
  "./shells/app.tsx": async () => ({
    Shell: ({ children }: { children?: ComponentChildren }) => h("div", { id: "shell" }, children),
    Loading: () => h(ReadsRoot, null),
  }),
};

function createApp() {
  return defineApp({
    shells: { app: "./shells/app.tsx" },
    routes: [
      route("/", "./routes/home.tsx", { shell: "app", render: "ssr" }),
      route("/spa", "./routes/spa.tsx", { shell: "app", render: "spa" }),
      route("/broken", "./routes/broken.tsx", { shell: "app", render: "ssr" }),
    ],
  });
}

function createRegistry(rootModule: RootModule | null) {
  return {
    routeModules: {
      "./routes/home.tsx": async () => ({
        loader: ({ root }: LoaderArgs) => {
          (root as RootState).seen.push("home");
          return { message: "hi" };
        },
        Component: () => h(ReadsRoot, null),
      }),
      "./routes/spa.tsx": async () => ({
        loader: () => ({ message: "spa" }),
        Component: () => h(ReadsRoot, null),
      }),
      "./routes/broken.tsx": async () => ({
        loader: () => {
          throw new PrachtHttpError(500, "broken");
        },
        Component: () => h("p", null, "never"),
        ErrorBoundary: () => h(ReadsRoot, null),
      }),
    },
    shellModules,
    ...(rootModule ? { rootModules: { "/src/root.tsx": async () => rootModule } } : {}),
  };
}

describe("app root", () => {
  afterEach(() => {
    setRootSnapshotHandler(null);
    vi.unstubAllGlobals();
  });

  it("creates root state per request and hands it to the loader", async () => {
    const rootModule = createRootModule();
    const registry = createRegistry(rootModule);

    const first = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/"),
    });
    const second = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/"),
    });

    const firstHtml = await first.text();
    const secondHtml = await second.text();
    expect(firstHtml).toContain('<p id="root-id">root-1</p>');
    expect(secondHtml).toContain('<p id="root-id">root-2</p>');
    expect(rootModule.setupCalls).toEqual([{ isServer: true }, { isServer: true }]);

    // Each request's snapshot describes only its own state.
    expect(parseHydrationState(firstHtml).root).toEqual({ id: 1, seen: ["home"] });
    expect(parseHydrationState(secondHtml).root).toEqual({ id: 2, seen: ["home"] });
  });

  it("creates the root after middleware and before the loader", async () => {
    const order: string[] = [];
    const rootModule: RootModule = {
      setup: () => {
        order.push("setup");
        return {};
      },
    };
    const app = defineApp({
      middleware: { gate: "./middleware/gate.ts" },
      routes: [
        route("/", "./routes/home.tsx", { middleware: ["gate"], render: "ssr" }),
        route("/closed", "./routes/home.tsx", { middleware: ["gate"], render: "ssr" }),
      ],
    });
    const registry = {
      middlewareModules: {
        "./middleware/gate.ts": async () => ({
          middleware: async ({ url }: { url: URL }, next: () => Promise<Response>) => {
            order.push("middleware");
            return url.pathname === "/closed" ? new Response("closed", { status: 403 }) : next();
          },
        }),
      },
      routeModules: {
        "./routes/home.tsx": async () => ({
          loader: ({ root }: LoaderArgs) => {
            order.push(root ? "loader with root" : "loader without root");
            return null;
          },
          Component: () => h("p", null, "home"),
        }),
      },
      rootModules: { "/src/root.tsx": async () => rootModule },
    };

    await handlePrachtRequest({ app, registry, request: new Request("http://localhost/") });
    expect(order).toEqual(["middleware", "setup", "loader with root"]);

    // A request middleware answers itself never creates a root.
    order.length = 0;
    const closed = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/closed"),
    });
    expect(closed.status).toBe(403);
    expect(order).toEqual(["middleware"]);
  });

  it("renders the root between the runtime provider and the shell", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: createRegistry(createRootModule()),
      request: new Request("http://localhost/"),
    });
    const html = await response.text();
    expect(html).toContain('<div id="shell"><p id="root-id">root-1</p></div>');
  });

  it("adds the snapshot to route-state responses", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: createRegistry(createRootModule()),
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.data).toEqual({ message: "hi" });
    expect(body.root).toEqual({ id: 1, seen: ["home"] });
  });

  it("omits the snapshot when dehydrate returns undefined", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: createRegistry(createRootModule()),
      request: new Request("http://localhost/spa", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("root");
  });

  it("wraps the SPA loading tree and error boundaries", async () => {
    const registry = createRegistry(createRootModule());
    const spa = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/spa"),
    });
    expect(await spa.text()).toContain('<div id="shell"><p id="root-id">root-1</p></div>');

    const broken = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/broken"),
    });
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain('<p id="root-id">root-2</p>');
  });

  it("blames the root module when setup() throws", async () => {
    const contexts: (RouteErrorContext | undefined)[] = [];
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: createRegistry({
        setup() {
          throw new Error("setup failed");
        },
      }),
      request: new Request("http://localhost/"),
      onRouteError: (_error, _path, context) => contexts.push(context),
    });
    expect(response.status).toBe(500);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.rootFile).toBe("/src/root.tsx");
    expect(describeRouteErrorModule(contexts[0])).toBe("/src/root.tsx");
  });

  it("changes nothing for an app without a root module", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: createRegistry(null),
      request: new Request("http://localhost/spa"),
    });
    const html = await response.text();
    expect(html).toContain('<div id="shell"><p id="root-id">no-root</p></div>');
    expect(parseHydrationState(html)).not.toHaveProperty("root");
  });

  it("passes route-state snapshots to the installed handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ok: true }, root: { queries: 1 } })),
    );
    const handler = vi.fn();
    setRootSnapshotHandler(handler);

    const result = await fetchPrachtRouteState("/");

    expect(result).toEqual({ type: "data", data: { ok: true }, fontHead: undefined });
    expect(handler).toHaveBeenCalledWith({ queries: 1 });
  });

  it("keeps the route data when the snapshot handler throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ok: true }, root: {} })),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setRootSnapshotHandler(() => {
      throw new Error("bad snapshot");
    });

    const result = await fetchPrachtRouteState("/");

    expect(result).toMatchObject({ type: "data", data: { ok: true } });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("app root on islands routes", () => {
  afterEach(() => {
    _resetIslandsForTesting();
  });

  function ReadsRootIsland() {
    return h("span", { id: "island" }, h(ReadsRoot, null));
  }

  function NeedsRootIsland() {
    if (!useContext(RootContext)) throw new Error("No root state set");
    return h("span", null, "never");
  }

  async function renderIslandsRoute(Island: () => unknown) {
    registerServerIslands({ "/src/islands/Widget.tsx": { default: Island } });
    setIslandsClientEntryUrl("/assets/islands-client.js");
    const errors: unknown[] = [];
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/page.tsx", { render: "ssr", hydration: "islands" })],
      }),
      registry: {
        routeModules: {
          "./routes/page.tsx": async () => ({
            Component: () => h("main", null, h(ReadsRoot, null), h(Island as () => null, null)),
          }),
        },
        rootModules: { "/src/root.tsx": async () => createRootModule() },
      },
      request: new Request("http://localhost/"),
      onRouteError: (error) => errors.push(error),
    });
    return { response, errors };
  }

  it("renders islands without what the root provides, as they hydrate", async () => {
    const { response } = await renderIslandsRoute(ReadsRootIsland);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<main><p id="root-id">root-1</p><pracht-island');
    expect(html).toContain('<span id="island"><p id="root-id">no-root</p></span>');
  });

  it("names the island when it fails without the root", async () => {
    const { response, errors } = await renderIslandsRoute(NeedsRootIsland);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
    const error = errors[0] as Error;
    expect(error.message).toContain(
      'Island "Widget" (/src/islands/Widget.tsx) threw while rendering: No root state set',
    );
    expect(error.message).toContain("without the app root's Root");
    expect((error.cause as Error).message).toBe("No root state set");
  });
});
