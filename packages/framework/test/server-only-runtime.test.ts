import { h } from "preact";
import { describe, expect, it } from "vitest";

import { StaticHtml, defineApp, handlePrachtRequest, route, serverOnly } from "../src/index.ts";
import { ROUTE_STATE_REQUEST_HEADER } from "../src/runtime-constants.ts";

const MARKUP = "<h1>Data Loading</h1><p>Loaders run on the server.</p>";

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
    expect(state.data.html).toEqual({ __prachtServerOnly: true });
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
});
