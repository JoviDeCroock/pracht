// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDevPageTools,
  DEV_ERROR_OVERLAY_DATA_ID,
  registerDevPageTools,
  toSerializable,
} from "../src/dev-page-tools.ts";
import { defer } from "../src/defer.ts";
import { PrachtRuntimeProvider } from "../src/runtime-context.ts";
import { HYDRATION_STATE_ELEMENT_ID } from "../src/runtime-constants.ts";

const graph = {
  routes: [
    {
      id: "notes",
      path: "/notes",
      file: "./routes/notes.tsx",
      render: "ssr",
      hydration: null,
      shell: "public",
      shellFile: "./shells/public.tsx",
      loaderFile: null,
      loaderCache: null,
      middleware: ["auth"],
      capabilities: ["notes.search", "notes.create", "ghost"],
      streaming: null,
      prefetch: null,
    },
    {
      id: "user",
      path: "/users/:id",
      file: "./routes/user.tsx",
      render: "ssr",
      hydration: "islands",
      shell: null,
      shellFile: null,
      loaderFile: "./routes/user.loader.ts",
      loaderCache: 60,
      middleware: [],
      capabilities: [],
      streaming: null,
      prefetch: null,
    },
  ],
  notFound: null,
  capabilities: [
    {
      name: "notes.search",
      title: "Search notes",
      description: "Find notes.",
      effect: "read",
      transports: ["http", "webmcp"],
      httpPath: "/api/capabilities/notes/search",
      input: { type: "object" },
    },
    {
      name: "notes.create",
      title: null,
      description: "Create.",
      effect: "write",
      transports: ["http"],
      httpPath: "/api/capabilities/notes/create",
      input: { type: "object" },
    },
  ],
  mcpEndpoint: "/mcp",
};

function graphFetch(status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(graph), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function setHydrationState(state: Record<string, unknown> | null): void {
  document.getElementById(HYDRATION_STATE_ELEMENT_ID)?.remove();
  delete (window as { __PRACHT_STATE__?: unknown }).__PRACHT_STATE__;
  if (!state) return;
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = HYDRATION_STATE_ELEMENT_ID;
  script.textContent = JSON.stringify(state);
  document.body.appendChild(script);
}

function setLocation(path: string): void {
  window.history.replaceState(null, "", path);
}

const mountedHosts: HTMLElement[] = [];
afterEach(() => {
  // Unmount providers even when an assertion failed, so a leaked runtime in
  // the module-level registry cannot cascade into later tests.
  for (const host of mountedHosts.splice(0)) act(() => render(null, host));
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-pracht-islands-hydrated");
  delete (window as { __PRACHT_STATE__?: unknown }).__PRACHT_STATE__;
  delete (window as { __PRACHT_ROUTER_READY__?: boolean }).__PRACHT_ROUTER_READY__;
  delete (document as { modelContext?: unknown }).modelContext;
});

describe("createDevPageTools", () => {
  it("defines only read-only, prefixed tools", () => {
    const { tools } = createDevPageTools({ devtoolsJsonUrl: "/_pracht.json" });
    expect(tools.map((tool) => tool.name)).toEqual([
      "pracht_route",
      "pracht_loader_data",
      "pracht_islands",
      "pracht_last_error",
      "pracht_page_tools",
    ]);
    for (const tool of tools) {
      expect(tool.effect).toBe("read");
      expect(tool.description).toMatch(/^Dev-only\./);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("answers unknown tools with an error envelope", async () => {
    const { dispatch } = createDevPageTools({ devtoolsJsonUrl: "/_pracht.json" });
    await expect(dispatch("pracht_nope", {})).resolves.toEqual({
      ok: false,
      error: { code: "unknown_tool", message: "Unknown dev page tool pracht_nope" },
    });
  });

  it("reads the route and loader data from the hydration state script", async () => {
    setLocation("/notes?q=1");
    setHydrationState({
      url: "/notes?q=1",
      routeId: "notes",
      data: { notes: [{ title: "First" }] },
    });
    const fetch = graphFetch();
    const { dispatch } = createDevPageTools({ devtoolsJsonUrl: "/base/_pracht.json", fetch });

    const route = await dispatch("pracht_route", {});
    expect(route).toMatchObject({
      ok: true,
      data: {
        url: "/notes?q=1",
        routeId: "notes",
        params: {},
        source: "hydration-state",
        clientRouter: false,
        matched: {
          id: "notes",
          hydration: "full",
          middleware: ["auth"],
          shellFile: "./shells/public.tsx",
          capabilities: ["notes.search", "notes.create", "ghost"],
          notFound: false,
        },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/base/_pracht.json",
      expect.objectContaining({ credentials: "same-origin" }),
    );

    await expect(dispatch("pracht_loader_data", {})).resolves.toEqual({
      ok: true,
      data: {
        routeId: "notes",
        url: "/notes?q=1",
        source: "hydration-state",
        data: { notes: [{ title: "First" }] },
      },
    });
    await expect(dispatch("pracht_loader_data", { path: "notes.0.title" })).resolves.toEqual({
      ok: true,
      data: {
        routeId: "notes",
        url: "/notes?q=1",
        source: "hydration-state",
        path: "notes.0.title",
        data: "First",
      },
    });
    await expect(dispatch("pracht_loader_data", { path: "notes.9" })).resolves.toEqual({
      ok: false,
      error: { code: "path_not_found", message: 'No value at "notes.9" in the loader data.' },
    });
    // Prototype keys are never loader data.
    for (const path of ["__proto__", "constructor", "notes.constructor"]) {
      await expect(dispatch("pracht_loader_data", { path })).resolves.toMatchObject({
        ok: false,
        error: { code: "path_not_found" },
      });
    }
    await expect(dispatch("pracht_loader_data", { path: 3 })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("prefers the mounted route runtime over the hydration state", async () => {
    setLocation("/notes");
    setHydrationState({ url: "/notes", routeId: "notes", data: { stale: true } });
    (window as { __PRACHT_ROUTER_READY__?: boolean }).__PRACHT_ROUTER_READY__ = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountedHosts.push(host);
    // The provider registers itself in a mount effect; act() flushes it.
    act(() => {
      render(
        h(PrachtRuntimeProvider, {
          data: { fresh: true },
          params: { id: "7" },
          routeId: "user",
          url: "/users/7",
          children: null,
        }),
        host,
      );
    });
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(),
    });

    await expect(dispatch("pracht_route", {})).resolves.toMatchObject({
      ok: true,
      data: {
        routeId: "user",
        url: "/users/7",
        params: { id: "7" },
        source: "runtime",
        clientRouter: true,
        matched: { id: "user", hydration: "islands", loaderFile: "./routes/user.loader.ts" },
      },
    });
    await expect(dispatch("pracht_loader_data", {})).resolves.toMatchObject({
      ok: true,
      data: { source: "runtime", data: { fresh: true } },
    });
  });

  it("matches the route by URL when the document carries no route state", async () => {
    setLocation("/users/42");
    setHydrationState(null);
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(),
    });

    await expect(dispatch("pracht_route", {})).resolves.toMatchObject({
      ok: true,
      data: {
        url: "/users/42",
        routeId: "user",
        params: { id: "42" },
        source: null,
        matched: { id: "user" },
      },
    });
    // An islands route never ships loader data; say so instead of "no state".
    await expect(dispatch("pracht_loader_data", {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: "no_route_state",
        message: expect.stringContaining('hydration: "islands"'),
      },
    });
  });

  it("reports the devtools endpoint being unavailable", async () => {
    setLocation("/notes");
    setHydrationState(null);
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(404),
    });
    await expect(dispatch("pracht_route", {})).resolves.toEqual({
      ok: false,
      error: {
        code: "devtools_unavailable",
        message: "/_pracht.json answered 404; is this a pracht dev server?",
      },
    });
  });

  it("lists islands with their hydration status and props", async () => {
    setLocation("/users/1");
    setHydrationState(null);
    document.body.innerHTML = `
      <pracht-island island="/src/islands/Counter.tsx" props='{"start":5}' data-hydrated="true"></pracht-island>
      <pracht-island island="/src/islands/Chart.tsx" export="Chart" client="visible" props="{oops"></pracht-island>
    `;
    document.documentElement.setAttribute("data-pracht-islands-hydrated", "true");
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(),
    });

    const result = await dispatch("pracht_islands", {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        routeId: "user",
        hydration: "islands",
        allHydrated: true,
        islands: [
          {
            file: "/src/islands/Counter.tsx",
            export: "default",
            strategy: "load",
            hydrated: true,
            props: { start: 5 },
          },
          {
            file: "/src/islands/Chart.tsx",
            export: "Chart",
            strategy: "visible",
            hydrated: false,
            props: null,
            propsError: expect.any(String),
          },
        ],
      },
    });
  });

  it("returns null for the islands marker on a document without islands", async () => {
    setLocation("/notes");
    setHydrationState({ url: "/notes", routeId: "notes", data: null });
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(),
    });
    await expect(dispatch("pracht_islands", {})).resolves.toMatchObject({
      ok: true,
      data: { hydration: "full", allHydrated: null, islands: [] },
    });
  });

  it("surfaces the overlay error, the hydration-state error, and client errors", async () => {
    setLocation("/notes");
    setHydrationState({
      url: "/notes",
      routeId: "notes",
      data: null,
      error: { message: "loader failed", name: "Error", status: 500 },
    });
    const pageTools = createDevPageTools({ devtoolsJsonUrl: "/_pracht.json", clientErrorLimit: 2 });

    await expect(pageTools.dispatch("pracht_last_error", {})).resolves.toEqual({
      ok: true,
      data: { server: { message: "loader failed", name: "Error", status: 500 }, client: [] },
    });

    const overlay = document.createElement("script");
    overlay.type = "application/json";
    overlay.id = DEV_ERROR_OVERLAY_DATA_ID;
    overlay.textContent = JSON.stringify({ message: "boom", phase: "render", routeId: "notes" });
    document.body.appendChild(overlay);
    // The overlay document wins: it replaced the route render entirely.
    await expect(pageTools.dispatch("pracht_last_error", {})).resolves.toMatchObject({
      ok: true,
      data: { server: { message: "boom", phase: "render", routeId: "notes" } },
    });

    const stop = pageTools.observeClientErrors();
    window.dispatchEvent(
      new ErrorEvent("error", { message: "first", error: new Error("first error") }),
    );
    window.dispatchEvent(new ErrorEvent("error", { message: "second (no error object)" }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("rejected");
    window.dispatchEvent(rejection);
    stop();
    window.dispatchEvent(new ErrorEvent("error", { message: "after stop" }));

    const result = (await pageTools.dispatch("pracht_last_error", {})) as {
      data: { client: { kind: string; message: string; stack?: string }[] };
    };
    // Newest first, bounded by the limit, and nothing recorded after stop().
    expect(result.data.client.map((entry) => [entry.kind, entry.message])).toEqual([
      ["unhandledrejection", "rejected"],
      ["error", "second (no error object)"],
    ]);
    expect(result.data.client[0].stack).toContain("rejected");
  });

  it("lists the app's page tools on the route and explains inactive ones", async () => {
    setLocation("/notes");
    setHydrationState({ url: "/notes", routeId: "notes", data: null });
    const { dispatch } = createDevPageTools({
      devtoolsJsonUrl: "/_pracht.json",
      fetch: graphFetch(),
    });
    await expect(dispatch("pracht_page_tools", {})).resolves.toEqual({
      ok: true,
      data: {
        routeId: "notes",
        active: [
          {
            name: "notes.search",
            title: "Search notes",
            description: "Find notes.",
            effect: "read",
            httpPath: "/api/capabilities/notes/search",
            input: { type: "object" },
          },
        ],
        inactive: [
          { name: "notes.create", reason: "capability does not set expose.webmcp" },
          { name: "ghost", reason: "not registered in defineApp({ capabilities })" },
        ],
        mcpEndpoint: "/mcp",
      },
    });
  });

  it("forwards the host's abort signal to the graph fetch", async () => {
    setLocation("/notes");
    setHydrationState(null);
    const fetch = graphFetch();
    const { dispatch } = createDevPageTools({ devtoolsJsonUrl: "/_pracht.json", fetch });
    const controller = new AbortController();
    await dispatch("pracht_route", {}, { signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith(
      "/_pracht.json",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("registerDevPageTools", () => {
  it("returns null without the WebMCP API", () => {
    expect(registerDevPageTools({ devtoolsJsonUrl: "/_pracht.json" })).toBeNull();
  });

  it("registers every tool with the host and removes them on abort", () => {
    const active = new Map<string, unknown>();
    (document as { modelContext?: unknown }).modelContext = {
      registerTool(tool: { name: string }, options?: { signal?: AbortSignal }) {
        active.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => active.delete(tool.name));
      },
    };
    const registration = registerDevPageTools({ devtoolsJsonUrl: "/_pracht.json" });
    expect(registration).not.toBeNull();
    expect([...active.keys()]).toEqual([
      "pracht_route",
      "pracht_loader_data",
      "pracht_islands",
      "pracht_last_error",
      "pracht_page_tools",
    ]);
    const tool = active.get("pracht_route") as { annotations: Record<string, unknown> };
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    registration!.abort();
    expect(active.size).toBe(0);
  });
});

describe("toSerializable", () => {
  it("keeps JSON as-is and rewrites what JSON.stringify would lose", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const value = {
      plain: { n: 1, s: "x", b: true, nil: null, list: [1, "two"] },
      deferred: defer(Promise.resolve(1)),
      promise: Promise.resolve(2),
      date: new Date("2026-09-06T00:00:00.000Z"),
      fn: function loader() {},
      error: new RangeError("bad"),
      map: new Map([["k", 1]]),
      set: new Set([1]),
      big: 10n,
      nan: Number.NaN,
      cyclic,
      bytes: new Uint8Array(3),
      url: new URL("https://example.test/a"),
    };
    const result = toSerializable(value) as Record<string, unknown>;
    expect(result.plain).toEqual({ n: 1, s: "x", b: true, nil: null, list: [1, "two"] });
    expect(result.deferred).toMatchObject({ $deferred: true });
    expect(result.promise).toEqual({ $promise: true });
    expect(result.date).toBe("2026-09-06T00:00:00.000Z");
    expect(result.fn).toBe("[Function loader]");
    expect(result.error).toMatchObject({ $error: "RangeError", message: "bad" });
    expect(result.map).toEqual([["k", 1]]);
    expect(result.set).toEqual([1]);
    expect(result.big).toBe("10n");
    expect(result.nan).toBe("NaN");
    expect(result.cyclic).toEqual({ name: "loop", self: "[Circular]" });
    expect(result.bytes).toBe("[Uint8Array 3 bytes]");
    expect(result.url).toBe("https://example.test/a");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("reports a throwing getter for its key and keeps the rest", () => {
    const value = {
      fine: 1,
      get broken(): never {
        throw new Error("getter exploded");
      },
      proxy: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("no keys for you");
          },
        },
      ),
    };
    expect(toSerializable(value)).toEqual({
      fine: 1,
      broken: { $throws: "getter exploded" },
      proxy: { $throws: "no keys for you" },
    });
  });

  it("isolates throws from nested reads, array elements, and probes", () => {
    const trapRow = new Proxy(
      { a: 1 },
      {
        get() {
          throw new Error("get trap");
        },
      },
    );
    const throwingIndex: unknown[] = [];
    Object.defineProperty(throwingIndex, 0, {
      enumerable: true,
      get() {
        throw new Error("elem getter");
      },
    });
    throwingIndex.length = 1;
    class BadError extends Error {
      override get message(): string {
        throw new Error("msg boom");
      }
    }
    const value = {
      rows: [trapRow, { ok: true }],
      indexed: throwingIndex,
      error: new BadError(),
      nested: {
        deeper: {
          get boom(): never {
            throw new Error("deep");
          },
          fine: 2,
        },
      },
    };
    expect(toSerializable(value)).toEqual({
      rows: [{ $throws: "get trap" }, { ok: true }],
      indexed: [{ $throws: "elem getter" }],
      error: { $throws: "msg boom" },
      nested: { deeper: { boom: { $throws: "deep" }, fine: 2 } },
    });
    // The top-level value itself may be hostile.
    expect(toSerializable(trapRow)).toEqual({ $throws: "get trap" });
  });

  it("bounds a wide shared DAG by node budget instead of exploding", () => {
    // fan-out 6 × depth 11 shares one leaf: exponential if every reference
    // were re-walked, a few thousand nodes with the budget.
    let layer: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 11; i += 1) {
      const shared = layer;
      layer = Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`k${k}`, shared]));
    }
    const started = Date.now();
    const result = JSON.stringify(toSerializable(layer));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toContain("[Truncated: node budget]");
    // A shared subgraph is not a cycle.
    const shared = { x: 1 };
    expect(toSerializable({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("bounds depth, array length, and string length", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20; i += 1) deep = { deep };
    const result = toSerializable({
      deep,
      long: Array.from({ length: 501 }, (_, i) => i),
      text: "x".repeat(10_001),
    }) as { deep: unknown; long: unknown[]; text: string };
    expect(JSON.stringify(result.deep)).toContain("[Truncated: max depth]");
    expect(result.long).toHaveLength(501);
    expect(result.long[500]).toBe("[1 more items]");
    expect(result.text.endsWith("[1 more characters]")).toBe(true);
  });
});
