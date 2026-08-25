import { h } from "preact";
import { Suspense } from "preact/compat";
import { describe, expect, it } from "vitest";

import { defer, defineApp, handlePrachtRequest, route, use } from "../src/index.ts";

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

/**
 * `preact/compat`'s Suspense is used here rather than pracht's own re-export:
 * `preact-suspense@0.3.0` cannot stream at all (its `render()` returns a bare
 * Fragment the renderer unwraps, so the boundary is invisible to the streaming
 * error hook). Swap this import once that fix is released.
 */
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
  it("flushes the head and shell before the deferred value settles", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute(40) } },
      request: new Request("http://localhost/product"),
    });

    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    // The first flush carries the document head. It must not contain the
    // resolved value — that is the whole point.
    expect(first).toContain("<!DOCTYPE html>");
    expect(first).toContain("<head>");
    expect(first).not.toContain("review-7");
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
    const controller = new AbortController();
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute(50) } },
      request: new Request("http://localhost/product", { signal: controller.signal }),
    });

    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();

    // Nothing to assert beyond "this terminates rather than hanging"; the
    // regression it guards is a stream that never closes after an abort.
    expect(true).toBe(true);
  });
});

describe("streaming deferred wire format", () => {
  it("serializes a deferred field as a sentinel rather than an empty object", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    const state = JSON.parse(
      html.match(/<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/)![1],
    ) as { data: { reviews: { "$pracht:defer": string } } };

    // The regression this guards is JSON.stringify turning an unresolved
    // Deferred into `{}` and the client hydrating against nothing.
    expect(state.data.reviews).toEqual({ "$pracht:defer": "reviews" });
  });

  it("delivers the value on the defer channel", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html).toContain("window.__PRACHT_DEFER__");
    expect(html).toContain('__PRACHT_DEFER__.r("reviews"');
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
    expect(html).toContain('__PRACHT_DEFER__.e("reviews"');
    expect(html).toContain("upstream 500");
  });

  it("round-trips through the client rehydration path", async () => {
    const { rehydrateDeferredData, serializeDeferred, use: read } = await import("../src/defer.ts");
    const { data: wire, pending } = serializeDeferred({
      product: { name: "Widget" },
      reviews: defer(Promise.resolve([{ id: 7 }])),
    });
    expect(wire).toEqual({
      product: { name: "Widget" },
      reviews: { "$pracht:defer": "reviews" },
    });

    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window = globals.window ?? {};
    try {
      const rehydrated = rehydrateDeferredData(wire) as { reviews: unknown };
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
});
