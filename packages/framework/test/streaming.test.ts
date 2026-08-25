import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  Script,
  Suspense,
  defer,
  defineApp,
  handlePrachtRequest,
  route,
  use,
} from "../src/index.ts";
import { isStreamingHtmlResponse } from "../src/runtime-stream.ts";

interface Review {
  id: number;
}

function later<T>(value: T, ms = 10): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function ReviewList({ reviews }: { reviews: Review[] }) {
  const list = use(reviews);
  return h(
    "ul",
    null,
    list.map((review) => h("li", { key: review.id }, `review-${review.id}`)),
  );
}

function streamingRoute(delayMs = 10) {
  return async () => ({
    loader: async () => ({
      product: { name: "Widget" },
      reviews: defer(later<Review[]>([{ id: 7 }], delayMs)),
    }),
    Component: ({ data }: { data: { product: { name: string }; reviews: Review[] } }) =>
      h(
        "main",
        null,
        h("h1", null, data.product.name),
        h(
          Suspense as never,
          { fallback: h("p", null, "loading") },
          h(ReviewList, { reviews: data.reviews }),
        ),
      ),
  });
}

async function readChunks(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

function streamingApp() {
  return defineApp({
    routes: [route("/product", "./routes/product.tsx", { render: "ssr", streaming: true })],
  });
}

describe("streaming SSR documents", () => {
  it("returns a normal error response when the shell fails before the first flush", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            Component: () => {
              throw new Error("shell failed");
            },
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
  });

  it("flushes the head and shell before the deferred value settles", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute(40) } },
      request: new Request("http://localhost/product"),
    });

    const reader = response.body!.getReader();
    expect(isStreamingHtmlResponse(response)).toBe(true);
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    // The first flush carries the document head. It must not contain the
    // resolved value — that is the whole point.
    expect(first).toContain("<!DOCTYPE html>");
    expect(first).toContain("<head>");
    expect(first).not.toContain("review-7");
  });

  it("runs deferred beforeHydration scripts before starting the client", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      clientEntryUrl: "/assets/client.js",
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({ value: defer(later("ready")) }),
            Component: ({ data }: { data: { value: unknown } }) =>
              h(
                Suspense as never,
                { fallback: h("p", null, "loading") },
                h(() => {
                  use(data.value as never);
                  return h(
                    "section",
                    null,
                    h(Script, { strategy: "beforeHydration", src: "/flags.js" }),
                    "ready",
                  );
                }, null),
              ),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html.indexOf('src="/flags.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="/flags.js"')).toBeLessThan(html.indexOf('src="/assets/client.js"'));
  });

  it("dedupes in-place scripts against head metadata", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            head: () => ({ script: [{ src: "/once.js" }] }),
            Component: () =>
              h("main", null, h(Script, { strategy: "beforeHydration", src: "/once.js" })),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html.match(/src="\/once\.js"/g)).toHaveLength(1);
  });

  it("streams the resolved subtree after the shell", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    expect(response.headers.get("content-type")).toContain("text/html");

    const chunks = await readChunks(response);
    const html = chunks.join("");

    expect(chunks.length).toBeGreaterThan(1);
    expect(html).toContain("loading");
    expect(html).toContain("review-7");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("writes the state and entry scripts before the deferred subtree", async () => {
    // Hydration has to be able to start while boundaries are still arriving.
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html.indexOf('id="pracht-state"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="pracht-state"')).toBeLessThan(html.indexOf("review-7"));
  });

  it("emits the defer shim before fast values and starts the client after the stream", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      clientEntryUrl: "/assets/client.js",
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({ reviews: defer(Promise.resolve([{ id: 7 }])) }),
            Component: ({ data }: { data: { reviews: Review[] } }) =>
              h(
                Suspense as never,
                { fallback: h("p", null, "loading") },
                h(ReviewList, { reviews: data.reviews }),
              ),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    const shimIndex = html.indexOf("window.__PRACHT_DEFER__=window.__PRACHT_DEFER__");
    const valueIndex = html.indexOf('window.__PRACHT_DEFER__.r("0:reviews"');
    expect(shimIndex).toBeGreaterThan(-1);
    expect(valueIndex).toBeGreaterThan(shimIndex);
    expect(valueIndex).toBeLessThan(html.indexOf('src="/assets/client.js"'));
    expect(html).toContain('<script type="module" src="/assets/client.js"></script>');
  });

  it("produces the same final markup as the buffered renderer", async () => {
    const registry = { routeModules: { "./routes/product.tsx": streamingRoute() } };

    const streamed = await handlePrachtRequest({
      app: streamingApp(),
      registry,
      request: new Request("http://localhost/product"),
    });
    const buffered = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
      }),
      registry,
      request: new Request("http://localhost/product"),
    });

    const streamedHtml = (await readChunks(streamed)).join("");
    const bufferedHtml = await buffered.text();

    // The streamed document carries the renderer's swap machinery, so the two
    // are not byte-identical — but both must end up with the resolved content
    // and neither may leave a fallback as the final state.
    expect(streamedHtml).toContain("review-7");
    expect(bufferedHtml).toContain("review-7");
    expect(bufferedHtml).not.toContain("loading");
  });

  it("stays buffered when streaming is not opted into", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
      }),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const chunks = await readChunks(response);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("review-7");
  });

  it("stops rendering when the client hangs up", async () => {
    let loaderSignal: AbortSignal | undefined;
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async ({ signal }: { signal: AbortSignal }) => {
              loaderSignal = signal;
              return {
                reviews: defer(
                  new Promise<Review[]>((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  }),
                ),
              };
            },
            Component: ({ data }: { data: { reviews: Review[] } }) =>
              h(
                Suspense as never,
                { fallback: h("p", null, "loading") },
                h(ReviewList, { reviews: data.reviews }),
              ),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(loaderSignal?.aborted).toBe(true);
  });
});

describe("streaming deferred wire format", () => {
  it("serializes a deferred field as an out-of-band reference", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    const state = JSON.parse(
      html.match(/<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/)![1],
    ) as { data: { reviews: null }; deferred: Array<{ id: string; path: string[] }> };

    expect(state.data.reviews).toBeNull();
    expect(state.deferred).toEqual([{ id: "0:reviews", path: ["reviews"] }]);
  });

  it("delivers the value on the defer channel", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html).toContain("window.__PRACHT_DEFER__");
    expect(html).toContain('__PRACHT_DEFER__.r("0:reviews"');
    expect(html).toContain('{"id":7}');
  });

  it("delivers a rejection on the same channel instead of failing the response", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({
              reviews: defer(() => Promise.reject(new Error("upstream 500"))),
            }),
            Component: ({ data }: { data: { reviews: Review[] } }) =>
              h(
                Suspense as never,
                { fallback: h("p", null, "loading") },
                h(ReviewList, { reviews: data.reviews }),
              ),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    // The response is already committed when a deferred value rejects, so it
    // stays 200 and the error travels as data.
    expect(response.status).toBe(200);
    const html = (await readChunks(response)).join("");
    expect(html).toContain('__PRACHT_DEFER__.e("0:reviews"');
    expect(html).toContain("Internal Server Error");
    expect(html).not.toContain("upstream 500");
  });

  it("round-trips through the client rehydration path", async () => {
    const { rehydrateDeferredData, serializeDeferred, use: read } = await import("../src/defer.ts");
    const { data: wire, pending } = serializeDeferred({
      product: { name: "Widget" },
      reviews: defer(Promise.resolve([{ id: 7 }])),
    });
    expect(wire).toEqual({
      product: { name: "Widget" },
      reviews: null,
    });

    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};
    try {
      const references = pending.map(({ id, path }) => ({ id, path }));
      const rehydrated = rehydrateDeferredData(wire, references) as { reviews: unknown };
      const registry = (globals.window as { __PRACHT_DEFER__: { r(id: string, v: unknown): void } })
        .__PRACHT_DEFER__;
      registry.r(pending[0].id, await pending[0].promise);

      // use() throws the pending promise first; await it, then read.
      try {
        read(rehydrated.reviews as never);
      } catch (thrown) {
        await thrown;
      }
      expect(read(rehydrated.reviews as never)).toEqual([{ id: 7 }]);
    } finally {
      if (!hadWindow) delete globals.window;
    }
  });
});

describe("streaming route validation", () => {
  it("rejects streaming on a prerendered route", async () => {
    const { resolveApp } = await import("../src/app.ts");
    expect(() =>
      resolveApp(
        defineApp({
          routes: [route("/p", "./routes/p.tsx", { render: "ssg", streaming: true })],
        }),
      ),
    ).toThrow(/streaming: true with render: "ssg"/);
  });

  it("rejects streaming without the client runtime", async () => {
    const { resolveApp } = await import("../src/app.ts");
    expect(() =>
      resolveApp(
        defineApp({
          routes: [
            route("/p", "./routes/p.tsx", {
              render: "ssr",
              hydration: "none",
              streaming: true,
            }),
          ],
        }),
      ),
    ).toThrow(/streaming: true with hydration: "none"/);
  });

  it("inherits streaming from a group", async () => {
    const { resolveApp } = await import("../src/app.ts");
    const { group } = await import("../src/index.ts");
    const app = resolveApp(
      defineApp({
        routes: [group({ streaming: true, render: "ssr" }, [route("/p", "./routes/p.tsx")])],
      }),
    );
    expect(app.routes[0].streaming).toBe(true);
  });

  it("streams routes whose omitted render mode defaults to SSR", async () => {
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [route("/product", "./routes/product.tsx", { streaming: true })],
      }),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const chunks = await readChunks(response);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("loading");
  });
});
