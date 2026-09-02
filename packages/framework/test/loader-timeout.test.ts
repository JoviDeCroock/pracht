import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defineApp,
  handlePrachtRequest,
  notFound,
  prerenderApp,
  resolveApiRoutes,
  route,
} from "../src/index.ts";

/** Resolve once `signal` aborts, or reject if it stays open past `ms`. */
function aborted(signal: AbortSignal, ms = 1_000): Promise<string> {
  if (signal.aborted) return Promise.resolve(String((signal.reason as Error)?.name));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("signal never aborted")), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(String((signal.reason as Error)?.name));
    });
  });
}

describe("the request signal handed to loaders and API handlers", () => {
  it("aborts when the client disconnects", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    const client = new AbortController();
    let loaderSignal: AbortSignal | undefined;

    const response = handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: async ({ signal }) => {
              loaderSignal = signal;
              // Hold the loader open so the abort lands mid-flight, exactly as
              // it would for a real request the visitor navigated away from.
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { ok: true };
            },
          }),
        },
      },
      request: new Request("http://localhost/", { signal: client.signal }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loaderSignal).toBeDefined();
    expect(loaderSignal!.aborted).toBe(false);
    client.abort();
    expect(await aborted(loaderSignal!)).toBe("AbortError");
    await response;
  });

  it("still aborts on the timeout when the client stays connected", async () => {
    const app = defineApp({
      loaderTimeoutMs: 10,
      routes: [route("/", "./routes/home.tsx")],
    });
    let loaderSignal: AbortSignal | undefined;

    await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }) => {
              loaderSignal = signal;
              return { ok: true };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(await aborted(loaderSignal!)).toBe("TimeoutError");
  });

  it("does not time out inside the configured budget", async () => {
    const app = defineApp({
      loaderTimeoutMs: 5_000,
      routes: [route("/", "./routes/home.tsx")],
    });
    let loaderSignal: AbortSignal | undefined;

    await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }) => {
              loaderSignal = signal;
              return { ok: true };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(loaderSignal!.aborted).toBe(false);
  });

  it("composes both reasons for API route handlers too", async () => {
    const app = defineApp({ routes: [] });
    const client = new AbortController();
    let handlerSignal: AbortSignal | undefined;

    const response = handlePrachtRequest({
      app,
      apiRoutes: resolveApiRoutes(["/src/api/slow.ts"]),
      registry: {
        apiModules: {
          "/src/api/slow.ts": async () => ({
            GET: async ({ signal }: { signal: AbortSignal }) => {
              handlerSignal = signal;
              await new Promise((resolve) => setTimeout(resolve, 50));
              return new Response("ok");
            },
          }),
        },
      },
      request: new Request("http://localhost/api/slow", { signal: client.signal }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    client.abort();
    expect(await aborted(handlerSignal!)).toBe("AbortError");
    await response;
  });

  it("renders the not-found page on the remaining budget, not a fresh one", async () => {
    const app = defineApp({
      loaderTimeoutMs: 20,
      notFound: "./routes/not-found.tsx",
      routes: [route("/", "./routes/home.tsx")],
    });
    let notFoundSignal: AbortSignal | undefined;

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: async () => {
              // Burn the whole budget before answering "no such thing".
              await new Promise((resolve) => setTimeout(resolve, 40));
              throw notFound();
            },
          }),
          "./routes/not-found.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }) => {
              notFoundSignal = signal;
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(response.status).toBe(404);
    // A fresh 30s budget here would hand the 404 page an open signal.
    expect(notFoundSignal!.aborted).toBe(true);
  });
});

describe("defineApp({ loaderTimeoutMs })", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (value) => {
    expect(() => defineApp({ loaderTimeoutMs: value, routes: [] })).toThrow(
      /positive number of milliseconds/,
    );
  });
});

/** A loader that runs until its signal aborts, then rethrows the reason. */
function abortableRoute(capture?: (signal: AbortSignal) => void) {
  return async () => ({
    Component: () => null,
    loader: ({ signal }: { signal: AbortSignal }) => {
      capture?.(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
}

describe("a request the client abandoned", () => {
  it("is not reported to onRouteError and answers 499", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    const client = new AbortController();
    const reported: unknown[] = [];

    const pending = handlePrachtRequest({
      app,
      registry: { routeModules: { "./routes/home.tsx": abortableRoute() } },
      onRouteError: (error) => reported.push(error),
      request: new Request("http://localhost/", { signal: client.signal }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    client.abort();
    const response = await pending;

    // An abandoned navigation is the visitor's decision, not an app fault:
    // reporting it fills Sentry with noise nobody can act on.
    expect(reported).toEqual([]);
    expect(response.status).toBe(499);
  });

  it("still reports a timeout, which is a real fault", async () => {
    const app = defineApp({ loaderTimeoutMs: 10, routes: [route("/", "./routes/home.tsx")] });
    const reported: unknown[] = [];

    const response = await handlePrachtRequest({
      app,
      registry: { routeModules: { "./routes/home.tsx": abortableRoute() } },
      onRouteError: (error) => reported.push(error),
      request: new Request("http://localhost/"),
    });

    expect(response.status).toBe(500);
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).name).toBe("TimeoutError");
  });

  it("reports a timeout even when the client disconnects afterwards", async () => {
    const app = defineApp({ loaderTimeoutMs: 10, routes: [route("/", "./routes/home.tsx")] });
    const client = new AbortController();
    const reported: unknown[] = [];
    let loaderSignal: AbortSignal | undefined;

    const pending = handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": abortableRoute((signal) => {
            loaderSignal = signal;
          }),
        },
      },
      onRouteError: (error) => reported.push(error),
      request: new Request("http://localhost/", { signal: client.signal }),
    });

    // Let the budget run out first, then disconnect.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await aborted(loaderSignal!)).toBe("TimeoutError");
    client.abort();
    const response = await pending;

    // The composed signal's reason names whichever source won the race.
    expect(response.status).toBe(500);
    expect(reported).toHaveLength(1);
  });
});

describe("runtimes without AbortSignal.any", () => {
  const original = AbortSignal.any;

  beforeEach(() => {
    delete (AbortSignal as { any?: unknown }).any;
  });

  afterEach(() => {
    (AbortSignal as { any?: unknown }).any = original;
  });

  it("still aborts the loader when the client disconnects", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    const client = new AbortController();
    let loaderSignal: AbortSignal | undefined;

    const pending = handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": abortableRoute((signal) => {
            loaderSignal = signal;
          }),
        },
      },
      request: new Request("http://localhost/", { signal: client.signal }),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    client.abort();
    expect(await aborted(loaderSignal!)).toBe("AbortError");
    await pending;
  });

  it("still aborts the loader on the budget", async () => {
    const app = defineApp({ loaderTimeoutMs: 10, routes: [route("/", "./routes/home.tsx")] });
    let loaderSignal: AbortSignal | undefined;

    await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              return { ok: true };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(await aborted(loaderSignal!)).toBe("TimeoutError");
  });
});

describe("prerendering under loaderTimeoutMs", () => {
  it("names the route and the budget when a build-time loader runs past it", async () => {
    const app = defineApp({
      loaderTimeoutMs: 15,
      routes: [route("/slow", "./routes/slow.tsx", { render: "ssg" })],
    });

    await expect(
      prerenderApp({
        app,
        clientEntryUrl: "/assets/client.js",
        registry: { routeModules: { "./routes/slow.tsx": abortableRoute() } },
      }),
    ).rejects.toThrow(/"\/slow"[\s\S]*15 ms request budget/);
  });
});
