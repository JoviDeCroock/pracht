import { h } from "preact";
import { describe, expect, it, vi } from "vitest";

// `pracht({ client: { richData: true } })` sets this define in both bundles.
// Hoisted above the imports: the runtime reads it once, at module load.
vi.hoisted(() => {
  (globalThis as { __PRACHT_RICH_DATA__?: boolean }).__PRACHT_RICH_DATA__ = true;
});

import { defineApp, handlePrachtRequest, route, serverOnly } from "../src/index.ts";
import { decodeRouteData } from "../src/route-data-codec.ts";
import { ROUTE_STATE_REQUEST_HEADER } from "../src/runtime-constants.ts";
import { isServerOnlyPlaceholder } from "../src/server-only.ts";

const MARKUP = "<p>Rendered once, on the server.</p>";

const page = () => ({
  app: defineApp({ routes: [route("/", "./routes/home.tsx", { render: "ssr" })] }),
  registry: {
    routeModules: {
      "./routes/home.tsx": async () => ({
        loader: () => ({
          byId: new Map([["a", serverOnly(MARKUP)]]),
          all: new Set([serverOnly(MARKUP)]),
        }),
        Component: () => h("main", null),
      }),
    },
  },
});

describe("serverOnly() with rich loader data", () => {
  it("strips marked values inside a Map or Set from the hydration state", async () => {
    const html = await (
      await handlePrachtRequest({ ...page(), request: new Request("http://localhost/") })
    ).text();
    const state = html.match(
      /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
    )![1];

    expect(state).not.toContain("Rendered once");
    const data = decodeRouteData((JSON.parse(state) as { data: unknown }).data) as {
      byId: Map<string, unknown>;
      all: Set<unknown>;
    };
    expect(data.byId).toBeInstanceOf(Map);
    expect(isServerOnlyPlaceholder(data.byId.get("a"))).toBe(true);
    expect(data.all).toBeInstanceOf(Set);
    expect(isServerOnlyPlaceholder([...data.all][0])).toBe(true);
  });

  it("keeps the real values in route-state responses", async () => {
    const response = await handlePrachtRequest({
      ...page(),
      request: new Request("http://localhost/", {
        headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
      }),
    });
    const data = decodeRouteData(((await response.json()) as { data: unknown }).data) as {
      byId: Map<string, unknown>;
      all: Set<unknown>;
    };
    expect(data.byId.get("a")).toBe(MARKUP);
    expect([...data.all]).toEqual([MARKUP]);
  });
});
