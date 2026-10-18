import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  StaticHtml,
  Suspense,
  defer,
  defineApp,
  handlePrachtRequest,
  route,
  serverOnly,
  use,
  useShellData,
} from "../src/index.ts";
import type { Deferred } from "../src/index.ts";
import { ROUTE_STATE_REQUEST_HEADER } from "../src/runtime-constants.ts";
import { fingerprintServerOnly } from "../src/server-only.ts";

const MARKUP = "<h1>Data Loading</h1><p>Loaders run on the server.</p>";
const PLACEHOLDER = { __prachtServerOnly: true, h: fingerprintServerOnly(MARKUP) };

/** A content route in the shape `@pracht/markdown` generates. */
const contentRoute = () => async () => ({
  loader: () => ({ html: serverOnly(MARKUP), title: "Data Loading" }),
  Component: ({ data }: { data: { html: string } }) =>
    h(StaticHtml as never, { class: "pracht-markdown", html: data.html }),
});

const app = defineApp({
  routes: [route("/docs/data-loading", "./routes/doc.tsx", { render: "ssr" })],
});

const registry = { routeModules: { "./routes/doc.tsx": contentRoute() } };

function parseShellState(html: string) {
  return parseHydrationState(html) as unknown as { shellData: { banner: unknown } };
}

function parseHydrationState(html: string) {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return JSON.parse(match[1]) as { data: { html: unknown; title: string } };
}

describe("serverOnly() through the SSR document path", () => {
  it("renders the markup into the document exactly once", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/docs/data-loading"),
    });

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<div class="pracht-markdown">');
    expect(html.split("Loaders run on the server.").length - 1).toBe(1);
  });

  it("replaces the marked field in the hydration state with a placeholder", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/docs/data-loading"),
    });

    const state = parseHydrationState(await response.text());
    expect(state.data.html).toEqual(PLACEHOLDER);
    // Unmarked fields are untouched.
    expect(state.data.title).toBe("Data Loading");
  });

  it("keeps the real value in the route-state response a navigation fetches", async () => {
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/docs/data-loading", {
        headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
      }),
    });

    const body = (await response.json()) as { data: { html: string } };
    expect(body.data.html).toBe(MARKUP);
  });

  it("leaves a route that marks nothing byte-identical", async () => {
    const plain = defineApp({
      routes: [route("/plain", "./routes/plain.tsx", { render: "ssr" })],
    });
    const response = await handlePrachtRequest({
      app: plain,
      registry: {
        routeModules: {
          "./routes/plain.tsx": async () => ({
            loader: () => ({ title: "Plain" }),
            Component: ({ data }: { data: { title: string } }) => h("h1", null, data.title),
          }),
        },
      },
      request: new Request("http://localhost/plain"),
    });

    const state = parseHydrationState(await response.text());
    expect(state.data).toEqual({ title: "Plain" });
  });

  it("strips the marked field from a streamed document's state too", async () => {
    const streamed = defineApp({
      routes: [route("/docs/data-loading", "./routes/doc.tsx", { render: "ssr", streaming: true })],
    });
    const response = await handlePrachtRequest({
      app: streamed,
      registry,
      request: new Request("http://localhost/docs/data-loading"),
    });

    const html = await response.text();
    expect(html.split("Loaders run on the server.").length - 1).toBe(1);
    expect(parseHydrationState(html).data.html).toEqual(PLACEHOLDER);
  });

  it("strips a marked field a shell loader returns, keeping it in route state", async () => {
    const shelled = defineApp({
      shells: { app: "./shells/app.tsx" },
      routes: [route("/", "./routes/home.tsx", { render: "ssr", shell: "app" })],
    });
    const shellRegistry = {
      routeModules: { "./routes/home.tsx": async () => ({ Component: () => h("main", null) }) },
      shellModules: {
        "./shells/app.tsx": async () => ({
          loader: () => ({ banner: serverOnly(MARKUP) }),
          Shell: ({ children }: { children: preact.ComponentChildren }) => {
            const shell = useShellData<{ banner: string }>();
            return h("div", null, h(StaticHtml as never, { html: shell?.banner }), children);
          },
        }),
      },
    };

    const html = await (
      await handlePrachtRequest({
        app: shelled,
        registry: shellRegistry,
        request: new Request("http://localhost/"),
      })
    ).text();
    expect(html.split("Loaders run on the server.").length - 1).toBe(1);
    expect(parseShellState(html).shellData.banner).toEqual(PLACEHOLDER);

    const routeState = await handlePrachtRequest({
      app: shelled,
      registry: shellRegistry,
      request: new Request("http://localhost/", {
        headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
      }),
    });
    const body = (await routeState.json()) as { shellData: { banner: string } };
    expect(body.shellData.banner).toBe(MARKUP);
  });

  it("strips a marked field resolved by a streamed defer()", async () => {
    const streamed = defineApp({
      routes: [route("/", "./routes/home.tsx", { render: "ssr", streaming: true })],
    });
    function Body({ value }: { value: Deferred<string> }) {
      return h(StaticHtml as never, { html: use(value) });
    }
    const response = await handlePrachtRequest({
      app: streamed,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            loader: () => ({ slow: defer(async () => serverOnly(MARKUP)) }),
            Component: ({ data }: { data: { slow: Deferred<string> } }) =>
              h(Suspense, { fallback: h("p", null, "loading") }, h(Body, { value: data.slow })),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await response.text();
    expect(html.split("Loaders run on the server.").length - 1).toBe(1);
    expect(html).toContain(JSON.stringify(PLACEHOLDER));
  });
});
