import { createContext, h } from "preact";
import type { ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  handlePrachtRequest,
  PrachtHttpError,
  route,
  type LoaderArgs,
  type RootModule,
  type RootSetupArgs,
} from "../src/index.ts";
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
    expect(rootModule.setupCalls).toHaveLength(2);
    expect(rootModule.setupCalls[0].isServer).toBe(true);
    expect(rootModule.setupCalls[0].request?.url).toBe("http://localhost/");

    // Each request's snapshot describes only its own state.
    expect(parseHydrationState(firstHtml).root).toEqual({ id: 1, seen: ["home"] });
    expect(parseHydrationState(secondHtml).root).toEqual({ id: 2, seen: ["home"] });
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
