import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function routeStateRequest(loader: () => unknown) {
  return handlePrachtRequest({
    app: defineApp({ routes: [route("/", "./routes/home.tsx")] }),
    registry: {
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          head: () => ({ title: "Home" }),
          loader,
        }),
      },
    },
    request: new Request("http://localhost/", { headers: { "x-pracht-route-state-request": "1" } }),
  });
}

describe("route-state responses", () => {
  it("are not read again after the framework built them", async () => {
    const clone = vi.spyOn(Response.prototype, "clone");

    const response = await routeStateRequest(() => ({ items: ["a", "b"] }));

    expect(await response.json()).toMatchObject({ data: { items: ["a", "b"] }, fontHead: {} });
    // A large loader payload used to be cloned and parsed a second time here,
    // only to return the original unchanged.
    expect(clone).not.toHaveBeenCalled();
  });

  it("still gain font fragments when a loader answers with its own JSON", async () => {
    const response = await routeStateRequest(() => Response.json({ data: { own: true } }));

    expect(await response.json()).toMatchObject({ data: { own: true }, fontHead: {} });
  });
});
