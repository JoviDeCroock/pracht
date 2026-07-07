import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { formatServerTimingHeader, type PrachtPhaseTimings } from "../src/runtime-timing.ts";

describe("formatServerTimingHeader", () => {
  it("formats all phases in stable order", () => {
    expect(formatServerTimingHeader({ loader: 14.84, mw: 1.23, render: 3.06 })).toBe(
      "mw;dur=1.2, loader;dur=14.8, render;dur=3.1",
    );
  });

  it("omits phases that were not recorded", () => {
    expect(formatServerTimingHeader({ mw: 0.5, render: 2 })).toBe("mw;dur=0.5, render;dur=2");
  });

  it("returns an empty string when nothing was recorded", () => {
    expect(formatServerTimingHeader({})).toBe("");
  });

  it("clamps negative durations to zero", () => {
    expect(formatServerTimingHeader({ mw: -0.04 })).toBe("mw;dur=0");
  });

  it("skips non-finite durations", () => {
    expect(formatServerTimingHeader({ loader: Number.NaN, mw: 1 })).toBe("mw;dur=1");
  });
});

describe("handlePrachtRequest timings option", () => {
  const app = defineApp({
    middleware: { logger: "./middleware/logger.ts" },
    routes: [route("/", "./routes/home.tsx", { middleware: ["logger"] })],
  });

  const registry = {
    middlewareModules: {
      "./middleware/logger.ts": async () => ({
        middleware: async (_args: unknown, next: () => Promise<Response>) => next(),
      }),
    },
    routeModules: {
      "./routes/home.tsx": async () => ({
        Component: () => null,
        loader: async () => ({ ok: true }),
      }),
    },
  };

  it("records middleware, loader, and render durations when a collector is passed", async () => {
    const timings: PrachtPhaseTimings = {};
    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/"),
      timings,
    });

    expect(response.status).toBe(200);
    expect(timings.mw).toBeTypeOf("number");
    expect(timings.loader).toBeTypeOf("number");
    expect(timings.render).toBeTypeOf("number");
    expect(formatServerTimingHeader(timings)).toMatch(
      /^mw;dur=\d+(\.\d+)?, loader;dur=\d+(\.\d+)?, render;dur=\d+(\.\d+)?$/,
    );
  });

  it("skips the loader phase when the route has no loader", async () => {
    const timings: PrachtPhaseTimings = {};
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/", "./routes/plain.tsx")] }),
      registry: {
        routeModules: {
          "./routes/plain.tsx": async () => ({ Component: () => null }),
        },
      },
      request: new Request("http://localhost/"),
      timings,
    });

    expect(response.status).toBe(200);
    expect(timings.loader).toBeUndefined();
    expect(timings.mw).toBeTypeOf("number");
    expect(timings.render).toBeTypeOf("number");
  });
});
