import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, redirect, resolveApiRoutes, route } from "../src/index.ts";
import type { RouteErrorContext } from "../src/runtime-errors.ts";

/** A promise that settles only when the test says so. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Resolve with the response, or with "pending" if it has not arrived within `ms`. */
function within(response: Promise<Response>, ms: number): Promise<Response | "pending"> {
  return Promise.race([
    response,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

function pageApp(options: { enforceLoaderTimeout?: boolean } = {}) {
  return defineApp({
    loaderTimeoutMs: 10,
    ...options,
    routes: [route("/", "./routes/home.tsx")],
  });
}

describe("defineApp({ enforceLoaderTimeout })", () => {
  it("answers with the timeout error when a loader ignores its signal", async () => {
    const loader = gate();
    const errors: unknown[] = [];

    const response = await within(
      handlePrachtRequest({
        app: pageApp({ enforceLoaderTimeout: true }),
        registry: {
          routeModules: {
            "./routes/home.tsx": async () => ({
              Component: () => h("p", null, "home"),
              loader: async () => {
                await loader.opened;
                return { late: true };
              },
            }),
          },
        },
        onRouteError: (error) => errors.push(error),
        request: new Request("http://localhost/"),
      }),
      1_000,
    );
    loader.open();

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(500);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe("TimeoutError");
  });

  it("answers an API request that ignores its signal", async () => {
    const handler = gate();

    const response = await within(
      handlePrachtRequest({
        app: defineApp({ loaderTimeoutMs: 10, enforceLoaderTimeout: true, routes: [] }),
        apiRoutes: resolveApiRoutes(["/src/api/slow.ts"]),
        registry: {
          apiModules: {
            "/src/api/slow.ts": async () => ({
              GET: async () => {
                await handler.opened;
                return new Response("late");
              },
            }),
          },
        },
        request: new Request("http://localhost/api/slow"),
      }),
      1_000,
    );
    handler.open();

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(500);
  });

  it("still answers when the error path itself hangs", async () => {
    const stuck = gate();

    const response = await within(
      handlePrachtRequest({
        app: pageApp({ enforceLoaderTimeout: true }),
        registry: {
          routeModules: {
            "./routes/home.tsx": async () => ({
              Component: () => h("p", null, "home"),
              loader: async () => {
                await stuck.opened;
                return {};
              },
              head: async () => {
                await stuck.opened;
                return { title: "late" };
              },
            }),
          },
        },
        request: new Request("http://localhost/", {
          headers: { "x-pracht-route-state-request": "1" },
        }),
      }),
      1_000,
    );
    stuck.open();

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(500);
  });

  it("bounds response finalization after middleware answered", async () => {
    const stuck = gate();

    const response = await within(
      handlePrachtRequest({
        app: defineApp({
          loaderTimeoutMs: 10,
          enforceLoaderTimeout: true,
          middleware: { answer: "./middleware/answer.ts" },
          routes: [route("/", "./routes/home.tsx", { middleware: ["answer"] })],
        }),
        registry: {
          middlewareModules: {
            "./middleware/answer.ts": async () => ({
              middleware: async () => Response.json({ data: { ok: true } }),
            }),
          },
          routeModules: {
            "./routes/home.tsx": async () => ({
              Component: () => h("p", null, "home"),
              head: async () => {
                await stuck.opened;
                return { title: "late" };
              },
            }),
          },
        },
        request: new Request("http://localhost/", {
          headers: { "x-pracht-route-state-request": "1" },
        }),
      }),
      1_000,
    );
    stuck.open();

    expect(response).not.toBe("pending");
  });

  it("cancels the body of a response a handler throws after the deadline", async () => {
    const handler = gate();
    let cancelled = false;

    const response = await within(
      handlePrachtRequest({
        app: defineApp({ loaderTimeoutMs: 10, enforceLoaderTimeout: true, routes: [] }),
        apiRoutes: resolveApiRoutes(["/src/api/slow.ts"]),
        registry: {
          apiModules: {
            "/src/api/slow.ts": async () => ({
              GET: async () => {
                await handler.opened;
                throw new Response(
                  new ReadableStream({
                    cancel() {
                      cancelled = true;
                    },
                  }),
                );
              },
            }),
          },
        },
        request: new Request("http://localhost/api/slow"),
      }),
      1_000,
    );
    handler.open();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((response as Response).status).toBe(500);
    expect(cancelled).toBe(true);
  });

  it("answers 499 without an error report when an API client leaves", async () => {
    const handler = gate();
    const client = new AbortController();
    const errors: unknown[] = [];

    const pending = handlePrachtRequest({
      app: defineApp({ loaderTimeoutMs: 5_000, enforceLoaderTimeout: true, routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/slow.ts"]),
      registry: {
        apiModules: {
          "/src/api/slow.ts": async () => ({
            GET: async () => {
              await handler.opened;
              return new Response("late");
            },
          }),
        },
      },
      onApiError: (error) => errors.push(error),
      request: new Request("http://localhost/api/slow", { signal: client.signal }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.abort();
    const response = await within(pending, 1_000);
    handler.open();

    expect((response as Response).status).toBe(499);
    expect(errors).toEqual([]);
  });

  it("is off by default: the response waits for the loader, as it always has", async () => {
    const loader = gate();
    const pending = handlePrachtRequest({
      app: pageApp(),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("p", null, "home"),
            loader: async () => {
              await loader.opened;
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(await within(pending, 60)).toBe("pending");
    loader.open();
    expect((await pending).status).toBe(200);
  });
});

describe("a shell loader that answers the request", () => {
  function shellApp(shellLoader: () => unknown, routeLoader: () => Promise<unknown>) {
    return {
      app: defineApp({
        shells: { app: "./shells/app.tsx" },
        routes: [route("/", "./routes/home.tsx", { shell: "app" })],
      }),
      registry: {
        shellModules: {
          "./shells/app.tsx": async () => ({
            Shell: ({ children }: { children?: unknown }) => h("div", null, children as never),
            loader: shellLoader,
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("p", null, "home"),
            loader: routeLoader,
          }),
        },
      },
    };
  }

  it("redirects without waiting for the route loader", async () => {
    const routeLoader = gate();
    const { app, registry } = shellApp(
      () => redirect("/login"),
      () => routeLoader.opened,
    );

    const response = await within(
      handlePrachtRequest({ app, registry, request: new Request("http://localhost/") }),
      1_000,
    );
    routeLoader.open();

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe("/login");
  });

  it("still attributes a shell loader failure to the shell", async () => {
    const routeLoader = gate();
    const reports: Array<RouteErrorContext | undefined> = [];
    const { app, registry } = shellApp(
      () => {
        throw new Error("shell down");
      },
      () => routeLoader.opened,
    );

    const response = await within(
      handlePrachtRequest({
        app,
        registry,
        onRouteError: (_error, _path, context) => reports.push(context),
        request: new Request("http://localhost/"),
      }),
      1_000,
    );
    routeLoader.open();

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ phase: "loader", loaderFile: "./shells/app.tsx" });
  });
});
