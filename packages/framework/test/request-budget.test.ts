import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defer, defineApp, handlePrachtRequest, resolveApiRoutes, route } from "../src/index.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect garbage a few times, then report whether `ref` is gone. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  // `deref()` keeps its target alive for the rest of the job, so only look
  // once collection has had its rounds.
  for (let round = 0; round < 20; round++) {
    gc();
    await sleep(1);
  }
  return ref.deref() === undefined;
}

/** Serve one request and read its body, holding neither once done — as an adapter does. */
async function serve(options: Parameters<typeof handlePrachtRequest>[0]): Promise<void> {
  await (await handlePrachtRequest(options)).text();
}

describe("the request budget ends with the request's work", () => {
  // A pending budget timer keeps the signal, and every abort listener's
  // closure, reachable until it fires. At the default 30 s budget that retained
  // about 2 KB per finished request, and 22 KB when a loader added a listener.
  it("lets a finished page request's signal be collected inside the budget", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    let ref: WeakRef<AbortSignal> | undefined;

    await serve({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("p", null, "home"),
            loader: ({ signal }: { signal: AbortSignal }) => {
              ref = new WeakRef(signal);
              const held = { blob: "x".repeat(20_000) };
              signal.addEventListener("abort", () => void held);
              return { ok: true };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(await collected(ref!)).toBe(true);
  });

  it("lets a finished API request's signal be collected inside the budget", async () => {
    let ref: WeakRef<AbortSignal> | undefined;

    await serve({
      app: defineApp({ routes: [] }),
      apiRoutes: resolveApiRoutes(["/src/api/ping.ts"]),
      registry: {
        apiModules: {
          "/src/api/ping.ts": async () => ({
            GET: ({ signal }: { signal: AbortSignal }) => {
              ref = new WeakRef(signal);
              signal.addEventListener("abort", () => {});
              return new Response("pong");
            },
          }),
        },
      },
      request: new Request("http://localhost/api/ping"),
    });

    expect(await collected(ref!)).toBe(true);
  });

  it("does not abort a finished request's signal when the budget runs out", async () => {
    let loaderSignal: AbortSignal | undefined;

    const response = await handlePrachtRequest({
      app: defineApp({ loaderTimeoutMs: 10, routes: [route("/", "./routes/home.tsx")] }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });
    await response.text();
    await sleep(30);

    expect(loaderSignal!.aborted).toBe(false);
  });

  it("still aborts a finished request's signal when the client disconnects", async () => {
    const client = new AbortController();
    let loaderSignal: AbortSignal | undefined;

    const response = await handlePrachtRequest({
      app: defineApp({ routes: [route("/", "./routes/home.tsx")] }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/", { signal: client.signal }),
    });
    await response.text();
    client.abort();

    expect(loaderSignal!.aborted).toBe(true);
  });

  it("keeps the budget running for waitUntil work", async () => {
    let loaderSignal: AbortSignal | undefined;
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const response = await handlePrachtRequest({
      app: defineApp({ loaderTimeoutMs: 10, routes: [route("/", "./routes/home.tsx")] }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            loader: ({
              signal,
              waitUntil,
            }: {
              signal: AbortSignal;
              waitUntil: (promise: Promise<unknown>) => void;
            }) => {
              loaderSignal = signal;
              waitUntil(work);
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });
    await response.text();
    await sleep(30);

    expect(loaderSignal!.aborted).toBe(true);
    expect((loaderSignal!.reason as Error).name).toBe("TimeoutError");
    finish();
  });

  it("keeps the budget running until a streamed document ends", async () => {
    let loaderSignal: AbortSignal | undefined;

    const response = await handlePrachtRequest({
      app: defineApp({
        loaderTimeoutMs: 10,
        routes: [route("/", "./routes/home.tsx", { streaming: true })],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("p", null, "shell"),
            loader: ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              // Settles well after the budget: the stream is still open then.
              return { slow: defer(sleep(40).then(() => "late")) };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });
    await response.text().catch(() => undefined);

    expect(loaderSignal!.aborted).toBe(true);
    expect((loaderSignal!.reason as Error).name).toBe("TimeoutError");
  });

  it("ends the budget once a streamed document has been read", async () => {
    let loaderSignal: AbortSignal | undefined;

    const response = await handlePrachtRequest({
      app: defineApp({
        loaderTimeoutMs: 30,
        routes: [route("/", "./routes/home.tsx", { streaming: true })],
      }),
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("p", null, "shell"),
            loader: ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              return { soon: defer(Promise.resolve("ready")) };
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });
    await response.text();
    await sleep(50);

    expect(loaderSignal!.aborted).toBe(false);
  });
});
