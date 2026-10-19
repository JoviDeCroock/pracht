// @vitest-environment jsdom
import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { defineApp, resolveApp, route } from "../src/index.ts";
import { mountRouter, reply, teardownRouterHarness } from "./router-harness.ts";

describe("client router: percent-escape case", () => {
  afterEach(teardownRouterHarness);

  // RFC 3986 makes `%c3%a9` and `%C3%A9` the same character; the server
  // matches either, so the client router must not hand one to the browser.
  it.each([
    ["/caf%C3%A9", "/caf%c3%a9"],
    ["/caf%c3%a9", "/caf%C3%A9"],
  ])("navigates to a route written %s at %s on the client", async (pattern, target) => {
    const app = resolveApp(
      defineApp({
        routes: [
          route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
          route(pattern, "./routes/cafe.tsx", { id: "cafe", render: "ssr" }),
        ],
      }),
    );
    const harness = await mountRouter({
      app,
      routeModules: {
        "./routes/home.tsx": async () => ({ default: () => h("main", null, "home") }),
        "./routes/cafe.tsx": async () => ({ default: () => h("main", null, "café") }),
      },
      state: { [target]: reply.data(null) },
    });

    await harness.navigate(target);

    expect(harness.handoffs).toEqual([]);
    expect(harness.root.textContent).toBe("café");
  });
});
