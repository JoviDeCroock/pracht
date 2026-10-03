import { afterEach, describe, expect, it, vi } from "vitest";

import { defineCapability } from "../../capabilities/src/index.ts";
import {
  addCapabilityAuditListener,
  clearCapabilityAuditListeners,
  invokeCapability,
} from "../../capabilities/src/server.ts";
import { defineApp, resolveApiRoutes, route } from "../src/app.ts";
import { handlePrachtRequest } from "../src/index.ts";
import { prerenderApp } from "../src/prerender.ts";
import type { RouteErrorContext } from "../src/runtime-errors.ts";
import { createWaitUntilTracker } from "../src/runtime-wait-until.ts";
import type { LoaderArgs, ModuleRegistry } from "../src/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
  clearCapabilityAuditListeners();
});

/** A promise the test settles by hand, to prove nothing waited on it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pageApp(loader: (args: LoaderArgs) => unknown) {
  const app = defineApp({
    middleware: { track: "./middleware/track.ts" },
    routes: [
      route("/", {
        component: "./routes/home.tsx",
        id: "home",
        middleware: ["track"],
        render: "ssr",
      }),
    ],
  });
  const registry: ModuleRegistry = {
    middlewareModules: {
      "./middleware/track.ts": async () => ({
        middleware: (args, next) => {
          args.waitUntil(Promise.resolve("middleware"));
          return next();
        },
      }),
    },
    routeModules: {
      "./routes/home.tsx": async () => ({
        Component: () => null,
        loader,
        head: (args) => {
          args.waitUntil(Promise.resolve("head"));
          return { title: "Home" };
        },
      }),
    },
  };
  return { app, registry };
}

describe("waitUntil() on server hooks", () => {
  it("hands middleware, loader, and head work to the adapter without delaying the response", async () => {
    const slow = deferred();
    const registered: Promise<unknown>[] = [];
    const { app, registry } = pageApp((args) => {
      args.waitUntil(slow.promise);
      return { ok: true };
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/"),
      waitUntil: (task) => registered.push(task),
    });

    // The loader's work is still pending, yet the response is complete.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Home</title>");
    expect(registered).toHaveLength(3);

    let finished = false;
    void Promise.all(registered).then(() => (finished = true));
    await Promise.resolve();
    expect(finished).toBe(false);
    slow.resolve();
    await Promise.all(registered);
    expect(finished).toBe(true);
  });

  it("reports a page rejection to onRouteError with phase waitUntil and never rejects the task", async () => {
    const registered: Promise<unknown>[] = [];
    const onRouteError = vi.fn<(error: unknown, path: string, ctx?: RouteErrorContext) => void>();
    const { app, registry } = pageApp((args) => {
      args.waitUntil(Promise.reject(new Error("analytics down")));
      return {};
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/?x=1"),
      waitUntil: (task) => registered.push(task),
      onRouteError,
    });
    expect(response.status).toBe(200);

    await expect(Promise.all(registered)).resolves.toBeDefined();
    expect(onRouteError).toHaveBeenCalledTimes(1);
    const [error, path, context] = onRouteError.mock.calls[0];
    expect((error as Error).message).toBe("analytics down");
    expect(path).toBe("/?x=1");
    expect(context).toMatchObject({
      phase: "waitUntil",
      routeFile: "./routes/home.tsx",
      routeId: "home",
    });
  });

  it("logs a rejection when the host supplies no hook and no platform waitUntil", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = deferred();
    const { app, registry } = pageApp((args) => {
      args.waitUntil(failure.promise);
      return {};
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/"),
    });
    expect(response.status).toBe(200);

    failure.reject(new Error("detached failure"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    expect(String(errors.mock.calls[0][0])).toContain(
      '[pracht] waitUntil error in route "home" (./routes/home.tsx) at /: detached failure',
    );
  });

  it("reports API route rejections to onApiError", async () => {
    const registered: Promise<unknown>[] = [];
    const onApiError = vi.fn<(error: unknown, path: string, ctx?: RouteErrorContext) => void>();
    const response = await handlePrachtRequest({
      app: defineApp({ routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/signup.ts"]),
      registry: {
        apiModules: {
          "/src/api/signup.ts": async () => ({
            GET: ({ waitUntil }) => {
              waitUntil(Promise.reject(new Error("mailer down")));
              return new Response("queued", { status: 202 });
            },
          }),
        },
      },
      request: new Request("http://localhost/api/signup"),
      waitUntil: (task) => registered.push(task),
      onApiError,
    });

    expect(response.status).toBe(202);
    await Promise.all(registered);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError.mock.calls[0][2]).toMatchObject({
      phase: "waitUntil",
      routeFile: "/src/api/signup.ts",
    });
  });
});

describe("waitUntil() in capabilities", () => {
  function capabilityApp(run: Parameters<typeof defineCapability>[0]["run"]) {
    const capability = defineCapability({
      title: "Track",
      description: "Record a visit.",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {} },
      effect: "write",
      expose: { http: true },
      run,
    });
    const app = defineApp({
      capabilities: { track: "./capabilities/track.ts" },
      routes: [route("/", { component: "./routes/home.tsx", render: "ssr" })],
    });
    const registry: ModuleRegistry = {
      capabilityModules: {
        "./capabilities/track.ts": async () => ({ default: capability }),
      },
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          loader: async ({ request }: LoaderArgs) => invokeCapability("track", {}, { request }),
        }),
      },
    };
    return { app, registry };
  }

  it("forwards run() work over HTTP and reports its rejection to onApiError", async () => {
    const registered: Promise<unknown>[] = [];
    const onApiError = vi.fn();
    const { app, registry } = capabilityApp(({ waitUntil }) => {
      waitUntil(Promise.reject(new Error("audit export failed")));
      return {};
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      waitUntil: (task) => registered.push(task),
      onApiError,
    });

    expect(response.status).toBe(200);
    expect(registered).toHaveLength(1);
    await Promise.all(registered);
    expect(onApiError.mock.calls[0][2]).toMatchObject({ phase: "waitUntil" });
  });

  it("forwards work from a capability composed in a loader", async () => {
    const registered: Promise<unknown>[] = [];
    const { app, registry } = capabilityApp(({ waitUntil }) => {
      waitUntil(Promise.resolve());
      return {};
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/"),
      waitUntil: (task) => registered.push(task),
    });

    expect(response.status).toBe(200);
    expect(registered).toHaveLength(1);
  });

  it("hands an async audit sink's delivery to waitUntil", async () => {
    const registered: Promise<unknown>[] = [];
    const delivery = deferred();
    addCapabilityAuditListener("exporter", () => delivery.promise);
    const { app, registry } = capabilityApp(() => ({}));

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/api/capabilities/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      waitUntil: (task) => registered.push(task),
    });

    expect(response.status).toBe(200);
    expect(registered).toHaveLength(1);
    delivery.resolve();
    await Promise.all(registered);
  });
});

describe("waitUntil() while prerendering", () => {
  it("finishes registered work before prerenderApp() resolves", async () => {
    const order: string[] = [];
    const app = defineApp({
      routes: [route("/", { component: "./routes/home.tsx", render: "ssg" })],
    });

    const pages = await prerenderApp({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ waitUntil }: LoaderArgs) => {
              waitUntil(
                new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
                  order.push("background");
                  // Work registered from inside other background work counts too.
                  waitUntil(Promise.resolve().then(() => order.push("nested")));
                }),
              );
              return {};
            },
          }),
        },
      },
    });

    order.push("returned");
    expect(pages).toHaveLength(1);
    expect(order).toEqual(["background", "nested", "returned"]);
  });

  it("does not fail the build when background work rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = defineApp({
      routes: [route("/", { component: "./routes/home.tsx", render: "ssg" })],
    });

    const pages = await prerenderApp({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ waitUntil }: LoaderArgs) => {
              waitUntil(Promise.reject(new Error("warmup failed")));
              return {};
            },
          }),
        },
      },
    });

    expect(pages).toHaveLength(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("waitUntil error");
  });
});

describe("createWaitUntilTracker", () => {
  it("drains pending work, including work registered while draining", async () => {
    const tracker = createWaitUntilTracker();
    const first = deferred();
    const done: string[] = [];
    tracker.waitUntil(
      first.promise.then(() => {
        done.push("first");
        tracker.waitUntil(Promise.resolve().then(() => done.push("second")));
      }),
    );
    expect(tracker.pending).toBe(1);

    const drained = tracker.drain(1_000);
    first.resolve();
    await expect(drained).resolves.toBe(true);
    expect(done).toEqual(["first", "second"]);
    expect(tracker.pending).toBe(0);
  });

  it("gives up at the timeout and never rejects", async () => {
    const tracker = createWaitUntilTracker();
    tracker.waitUntil(new Promise(() => {}));
    tracker.waitUntil(Promise.reject(new Error("ignored")));

    await expect(tracker.drain(10)).resolves.toBe(false);
    expect(tracker.pending).toBe(1);
  });
});
