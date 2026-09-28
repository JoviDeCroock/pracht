import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

// `pracht({ client: { richData: true } })` sets this define in both bundles.
// Hoisted above the imports: the runtime reads it once, at module load.
vi.hoisted(() => {
  (globalThis as { __PRACHT_RICH_DATA__?: boolean }).__PRACHT_RICH_DATA__ = true;
});

import { serializeDeferred } from "../src/defer.ts";
import {
  Suspense,
  defer,
  defineApp,
  handlePrachtRequest,
  prerenderApp,
  route,
  use,
} from "../src/index.ts";
import { decodeRouteData } from "../src/route-data-codec.ts";
import type { RouteMeta } from "../src/types.ts";

/**
 * Loader data reaches the browser through several transports. With rich data
 * on, each must carry the same encoding, so a Date is a Date whichever way it
 * arrived. The default (plain JSON) is covered in route-data-default.test.ts.
 */

const createdAt = new Date("2026-03-04T05:06:07.000Z");
const richData = () => {
  const author = { name: "Ada" };
  return {
    createdAt,
    tags: new Map([["a", new Set([1n])]]),
    author,
    editor: author,
  };
};
type RichData = ReturnType<typeof richData>;

function expectRich(data: RichData) {
  expect(data.createdAt).toBeInstanceOf(Date);
  expect(data.createdAt.getTime()).toBe(createdAt.getTime());
  expect(data.tags).toBeInstanceOf(Map);
  expect(data.tags.get("a")).toEqual(new Set([1n]));
  expect(data.author).toBe(data.editor);
}

function hydrationData(html: string): unknown {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return decodeRouteData((JSON.parse(match[1]) as { data: unknown }).data);
}

async function readText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function page(loader: () => unknown, options: RouteMeta = {}) {
  return {
    app: defineApp({ routes: [route("/", "./routes/home.tsx", options)] }),
    registry: {
      routeModules: {
        "./routes/home.tsx": async () => ({
          loader,
          Component: () => h("main", null, "home"),
        }),
      },
    },
  };
}

describe("rich loader data transports", () => {
  it("encodes the SSR hydration state", async () => {
    const response = await handlePrachtRequest({
      ...page(richData),
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(200);
    expectRich(hydrationData(await response.text()) as RichData);
  });

  it("encodes route-state responses for client navigation", async () => {
    const response = await handlePrachtRequest({
      ...page(richData),
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expectRich(decodeRouteData(body.data) as RichData);
  });

  it("encodes static-export route-state files", async () => {
    const { app, registry } = page(richData, { render: "ssg" });
    const pages = await prerenderApp({ app, registry, staticExport: true });
    const home = pages.find((entry) => entry.path === "/");
    const state = JSON.parse(home!.routeState!) as { data: unknown };
    expectRich(decodeRouteData(state.data) as RichData);
    expectRich(hydrationData(home!.html) as RichData);
  });

  it("encodes streamed deferred values", async () => {
    function Rich({ value }: { value: RichData }) {
      const data = use(value);
      return h("p", null, data.createdAt.toISOString());
    }
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/home.tsx", { render: "ssr", streaming: true })],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            loader: async () => ({ rich: defer(Promise.resolve(richData())) }),
            Component: ({ data }: { data: { rich: RichData } }) =>
              h(
                Suspense as never,
                { fallback: h("p", null, "loading") },
                h(Rich, { value: data.rich }),
              ),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await readText(response);
    const match = html.match(/__PRACHT_DEFER__\.r\("[^"]*",([\s\S]*?)\)<\/script>/);
    expect(match).not.toBeNull();
    expectRich(decodeRouteData(JSON.parse(match![1])) as RichData);
  });

  it("streams a deferred value that resolves to undefined", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/home.tsx", { render: "ssr", streaming: true })],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            loader: async () => ({ nothing: defer(Promise.resolve(undefined)) }),
            Component: () => h("main", null, "shell"),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await readText(response);
    expect(html).toMatch(/__PRACHT_DEFER__\.r\("[^"]*",undefined\)<\/script>/);
  });

  it("delivers an unserializable deferred value as a boundary error", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/", "./routes/home.tsx", { render: "ssr", streaming: true })],
      }),
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            loader: async () => ({ bad: defer(Promise.resolve({ fn: () => {} })) }),
            Component: () => h("main", null, "shell"),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await readText(response);
    expect(response.status).toBe(200);
    expect(html).toContain("__PRACHT_DEFER__.e(");
    expect(html).toContain("data.fn is a function");
  });

  it("fails the request with the offending path for unsupported values", async () => {
    let reported: unknown;
    const response = await handlePrachtRequest({
      ...page(() => ({ user: { save: () => {} } })),
      debugErrors: true,
      onRouteError: (error) => {
        reported = error;
      },
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(500);
    expect(String(reported)).toContain("data.user.save is a function");

    const stateResponse = await handlePrachtRequest({
      ...page(() => ({ user: { save: () => {} } })),
      debugErrors: true,
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    expect(stateResponse.status).toBe(500);
    const body = (await stateResponse.json()) as { error: { message: string } };
    expect(body.error.message).toContain("data.user.save is a function");
  });

  it("keeps a shared object shared across defer() and records its deferred value once", () => {
    const shared = { value: defer(Promise.resolve("ok")) };
    const { data, pending } = serializeDeferred({ first: shared, second: shared });

    expect(data).toEqual({ first: { value: null }, second: { value: null } });
    const copy = data as { first: object; second: object };
    expect(copy.first).toBe(copy.second);
    expect(pending.map(({ path }) => path)).toEqual([["first", "value"]]);
  });

  it("does not serialize data for routes that ship no hydration state", async () => {
    class Model {
      name = "server only";
    }
    const response = await handlePrachtRequest({
      ...page(() => ({ model: new Model() }), { hydration: "none" }),
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("pracht-state");
  });
});

describe("rich shell loader data", () => {
  const joinedAt = new Date("2020-05-06T07:08:09.000Z");

  /** A route under a shell whose loader returns `shellData()`. */
  function shellPage(
    shellData: () => unknown = () => ({ joinedAt, roles: new Set(["admin"]) }),
    options: RouteMeta = {},
  ) {
    return {
      app: defineApp({
        shells: { app: "./shells/app.tsx" },
        routes: [route("/", "./routes/home.tsx", { shell: "app", ...options })],
      }),
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            loader: richData,
            search: {
              "~standard": {
                version: 1 as const,
                vendor: "test",
                validate: (value: unknown) =>
                  (value as { page?: string }).page === "-1"
                    ? { issues: [{ message: "Expected a positive page" }] }
                    : { value },
              },
            },
            Component: () => h("main", null, "home"),
            ErrorBoundary: () => h("p", null, "bad query"),
          }),
        },
        shellModules: {
          "./shells/app.tsx": async () => ({
            Shell: ({ children }: { children: preact.ComponentChildren }) => children,
            loader: shellData,
          }),
        },
      },
    };
  }

  function expectShell(shellData: unknown) {
    const shell = shellData as { joinedAt: Date; roles: Set<string> };
    expect(shell.joinedAt).toBeInstanceOf(Date);
    expect(shell.joinedAt.getTime()).toBe(joinedAt.getTime());
    expect(shell.roles).toEqual(new Set(["admin"]));
  }

  it("encodes shell data in the hydration state beside route data", async () => {
    const response = await handlePrachtRequest({
      ...shellPage(),
      request: new Request("http://localhost/"),
    });
    const html = await response.text();
    const state = JSON.parse(
      html.match(/<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/)![1],
    ) as { data: unknown; shellData: unknown };
    expectRich(decodeRouteData(state.data) as RichData);
    expectShell(decodeRouteData(state.shellData));
  });

  it("encodes shell data in route-state responses", async () => {
    const response = await handlePrachtRequest({
      ...shellPage(),
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    const body = (await response.json()) as { data: unknown; shellData: unknown };
    expectRich(decodeRouteData(body.data) as RichData);
    expectShell(decodeRouteData(body.shellData));
  });

  it("encodes shell data in a route error, such as a rejected query", async () => {
    const document = await handlePrachtRequest({
      ...shellPage(),
      request: new Request("http://localhost/?page=-1"),
    });
    expect(document.status).toBe(400);
    const html = await document.text();
    const state = JSON.parse(
      html.match(/<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/)![1],
    ) as { shellData: unknown };
    expectShell(decodeRouteData(state.shellData));

    const routeState = await handlePrachtRequest({
      ...shellPage(),
      request: new Request("http://localhost/?page=-1", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    expect(routeState.status).toBe(400);
    const body = (await routeState.json()) as { error: { status: number }; shellData: unknown };
    expect(body.error.status).toBe(400);
    expectShell(decodeRouteData(body.shellData));
  });

  it("fails as the shell loader's error when shell data cannot be sent", async () => {
    let reported: unknown;
    const response = await handlePrachtRequest({
      ...shellPage(() => ({ save: () => {} })),
      onRouteError: (error) => {
        reported = error;
      },
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(500);
    expect(String(reported)).toContain('Loader data for shell "app"');
    expect(String(reported)).toContain("data.save is a function");
  });

  it("does not check shell data on pages that ship none", async () => {
    const response = await handlePrachtRequest({
      ...shellPage(() => ({ save: () => {} }), { hydration: "islands" }),
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(200);
  });
});
