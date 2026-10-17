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
