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
