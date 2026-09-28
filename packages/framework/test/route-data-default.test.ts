/**
 * Without `pracht({ client: { richData: true } })`, route and shell loader data
 * travel as plain `JSON.stringify` output on every transport, exactly as they
 * did before the rich encoding existed. Rich data is
 * route-data-transport.test.ts.
 */
import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";

class Row {
  id = 1;
}

const loaderData = () => ({
  createdAt: new Date("2026-03-04T05:06:07.000Z"),
  row: new Row(),
  save: () => {},
  missing: undefined,
});

function page() {
  return {
    app: defineApp({
      shells: { app: "./shells/app.tsx" },
      routes: [route("/", "./routes/home.tsx", { shell: "app" })],
    }),
    registry: {
      routeModules: {
        "./routes/home.tsx": async () => ({
          loader: loaderData,
          Component: () => h("main", null, "home"),
        }),
      },
      shellModules: {
        "./shells/app.tsx": async () => ({
          Shell: ({ children }: { children: preact.ComponentChildren }) => children,
          loader: loaderData,
        }),
      },
    },
  };
}

const expected = JSON.parse(JSON.stringify(loaderData()));

describe("loader data without rich data", () => {
  it("writes the hydration state as plain JSON", async () => {
    const response = await handlePrachtRequest({
      ...page(),
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const match = html.match(
      /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
    );
    const state = JSON.parse(match![1]) as { data: unknown; shellData: unknown };
    expect(state.data).toEqual(expected);
    expect(state.shellData).toEqual(expected);
    expect(match![1]).not.toContain("\\u0000");
  });

  it("answers route-state requests with plain JSON", async () => {
    const response = await handlePrachtRequest({
      ...page(),
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown; shellData: unknown };
    expect(body.data).toEqual(expected);
    expect(body.shellData).toEqual(expected);
  });
});
