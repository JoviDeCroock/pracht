import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApiRoutes, route } from "../src/app.ts";
import { notFound } from "../src/types.ts";
import { handlePrachtRequest } from "../src/runtime.ts";

/** Collect what the runtime writes to the console during one request. */
function captureConsole(): { lines: () => string[] } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map((call) => String(call[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const THROWING_API = defineApp({ routes: [] });

async function requestThrowingApi(options: { onApiError?: () => void } = {}): Promise<Response> {
  return handlePrachtRequest({
    apiRoutes: resolveApiRoutes(["/src/api/throws.ts"]),
    app: THROWING_API,
    registry: {
      apiModules: {
        "/src/api/throws.ts": async () => ({
          GET: () => {
            throw new Error("kaboom from an api route");
          },
        }),
      },
    },
    request: new Request("http://localhost/api/throws"),
    ...options,
  });
}

describe("a request failure with no host to report it to", () => {
  it("logs the phase, file, path, and message of a failing API handler", async () => {
    // The generated server entry passes no hook, so silence here is a deployed
    // app answering 500 with nothing in its log.
    const console = captureConsole();
    const response = await requestThrowingApi();

    expect(response.status).toBe(500);
    expect(console.lines()).toHaveLength(1);
    expect(console.lines()[0]).toContain(
      "[pracht] api error (/src/api/throws.ts) at /api/throws: kaboom from an api route",
    );
  });

  it("carries the stack, which production has no error overlay to replace", async () => {
    const console = captureConsole();
    await requestThrowingApi();

    expect(console.lines()[0]).toContain("Error: kaboom from an api route\n");
  });

  it("names the route and the phase of a failing loader", async () => {
    const console = captureConsole();
    const app = defineApp({
      routes: [route("/blog", { component: "./routes/blog.tsx", id: "blog" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/blog.tsx": async () => ({
            Component: () => null,
            loader: () => {
              throw new Error("loader exploded");
            },
          }),
        },
      },
      request: new Request("http://localhost/blog"),
    });

    expect(response.status).toBe(500);
    expect(console.lines()[0]).toContain(
      '[pracht] loader error in route "blog" (./routes/blog.tsx) at /blog: loader exploded',
    );
  });

  it("stays quiet for a failure that is a routing outcome", async () => {
    // `throw notFound()` answers 404 by design; logging it would make every
    // missing page look like a crash.
    const console = captureConsole();
    const app = defineApp({
      routes: [route("/blog", { component: "./routes/blog.tsx", id: "blog" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/blog.tsx": async () => ({
            Component: () => null,
            loader: () => {
              throw notFound("no such post");
            },
          }),
        },
      },
      request: new Request("http://localhost/blog"),
    });

    expect(response.status).toBe(404);
    expect(console.lines()).toEqual([]);
  });

  it("defers entirely to a host that supplies a hook", async () => {
    // The dev server swaps in its overlay and the prerenderer blames a route in
    // the build output; neither wants a second line underneath.
    const console = captureConsole();
    const onApiError = vi.fn();
    await requestThrowingApi({ onApiError });

    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(console.lines()).toEqual([]);
  });
});
