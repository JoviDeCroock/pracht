import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

// A static export bakes `__PRACHT_STATIC_TARGET__` into the server bundle;
// stand in for that build here.
vi.mock("../src/runtime-static.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime-static.ts")>()),
  IS_STATIC_TARGET: true,
}));

const { defineApp, handlePrachtRequest, route } = await import("../src/index.ts");
const { _resetRegionsForTesting, registerServerRegions } = await import("../src/regions-server.ts");

afterEach(() => {
  _resetRegionsForTesting();
});

describe("regions on a static export", () => {
  it("fails the prerender with a pointer to a server adapter", async () => {
    function Cart() {
      return h("span", null, "cart");
    }
    registerServerRegions({ "/src/regions/Cart.tsx": { default: Cart } });
    const onRouteError = vi.fn();

    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/", "./routes/page.tsx", { render: "ssg" })] }),
      registry: {
        routeModules: {
          "./routes/page.tsx": async () => ({ Component: () => h(Cart, null) }),
        },
      },
      request: new Request("http://localhost/"),
      onRouteError,
    });

    expect(response.status).toBe(500);
    expect(String(onRouteError.mock.calls[0][0])).toContain(
      "the static adapter deploys no server to answer region requests",
    );
  });
});
