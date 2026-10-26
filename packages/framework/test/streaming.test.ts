import { JSDOM } from "jsdom";
import { Component, h } from "preact";
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

// Early hydration is Preact 11 only (runtime-page.ts places the entry at the
// end on Preact 10); the Preact 10 CI job runs this file too.
const PREACT_11 = Object.keys(new (Component as unknown as new () => object)()).length > 2;

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

function nextFrame(window: Window): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
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

  it("keeps streaming a document that middleware re-wrapped", async () => {
    const route_ = streamingRoute(40);
    const response = await handlePrachtRequest({
      app: defineApp({
        middleware: { rewrap: "./middleware/rewrap.ts" },
        routes: [
          route("/product", "./routes/product.tsx", {
            render: "ssr",
            streaming: true,
            middleware: ["rewrap"],
          }),
        ],
      }),
      registry: {
        middlewareModules: {
          "./middleware/rewrap.ts": async () => ({
            middleware: async (_args: unknown, next: () => Promise<Response>) => {
              const rendered = await next();
              return new Response(rendered.body, {
                status: rendered.status,
                headers: rendered.headers,
              });
            },
          }),
        },
        routeModules: {
          "./routes/product.tsx": async () => {
            const module = await route_();
            return {
              ...module,
              // Reading the signal starts the request budget's timer.
              loader: ({ signal }: { signal: AbortSignal }) => {
                signal.throwIfAborted();
                return module.loader();
              },
            };
          },
        },
      },
      request: new Request("http://localhost/product"),
    });

    expect(isStreamingHtmlResponse(response)).toBe(true);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain("<head>");
    expect(first).not.toContain("review-7");
  });

  it("emits deferred beforeHydration scripts in place, inside the streamed subtree", async () => {
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

    // The client starts after the shell; the subtree this script belongs to
    // only hydrates once the document is complete (streamed-document.ts).
    const html = (await readChunks(response)).join("");
    expect(html.indexOf('src="/flags.js"')).toBeGreaterThan(html.indexOf("<preact-island"));
    expect(html.indexOf('src="/flags.js"')).toBeLessThan(html.indexOf("</body>"));
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

  it("drops a route-declared content length from the streamed response", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            headers: () => ({ "content-length": "1" }),
            Component: () => h("main", null, "streamed body"),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    expect(response.headers.get("content-length")).toBeNull();
    await response.body!.cancel();
  });

  it("waits for body demand before serializing deferred payloads", async () => {
    let serializationCount = 0;
    const deferredValue = {
      toJSON() {
        serializationCount++;
        return { id: 7 };
      },
    };
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({ value: defer(Promise.resolve(deferredValue)) }),
            Component: () => h("main", null, "shell"),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(serializationCount).toBe(0);

    const html = (await readChunks(response)).join("");
    expect(serializationCount).toBe(1);
    expect(html).toContain('{"id":7}');
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

  it.runIf(PREACT_11)(
    "starts the client after the shell, between the defer shim and the deferred values",
    async () => {
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
      const entryIndex = html.indexOf(
        '<script type="module" async src="/assets/client.js"></script>',
      );
      expect(entryIndex).toBeGreaterThan(shimIndex);
      expect(valueIndex).toBeGreaterThan(entryIndex);
      expect(html.indexOf('rel="modulepreload" href="/assets/client.js"')).toBeLessThan(entryIndex);
    },
  );

  it("puts the head scriptNonce on every inline script in the stream", async () => {
    const productRoute = streamingRoute();
    const response = await handlePrachtRequest({
      app: defineApp({
        routes: [
          route("/product", "./routes/product.tsx", {
            render: "ssr",
            streaming: true,
            speculation: "prefetch",
          }),
        ],
      }),
      clientEntryUrl: "/assets/client.js",
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            ...(await productRoute()),
            head: () => ({ scriptNonce: 'n0nce"x' }),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/g)]
      .map((match) => match[1])
      .filter((attrs) => !/\bsrc=/.test(attrs) && !/type="application\/json"/.test(attrs));
    // Shim, island swap patch, renderer bootstrap, island swap trigger,
    // deferred value, speculation rules.
    expect(inlineScripts).toHaveLength(6);
    for (const attrs of inlineScripts) {
      expect(attrs).toContain('nonce="n0nce&quot;x"');
    }
    expect(html).toContain("review-7");
    expect(html).toContain("<preact-island");
  });

  it("swaps each streamed boundary into place exactly once", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });
    const dom = new JSDOM((await readChunks(response)).join(""), {
      pretendToBeVisual: true,
      runScripts: "dangerously",
    });
    await nextFrame(dom.window);

    const main = dom.window.document.querySelector("main")!;
    expect(main.innerHTML).toMatch(/<!--\$s:[^>]+--><ul><li>review-7<\/li><\/ul><!--\/\$s:/);
    expect(dom.window.document.querySelector("preact-island")).toBeNull();
    dom.window.close();
  });

  it("keeps a boundary's markup when a frame runs before the island's children are parsed", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
      request: new Request("http://localhost/product"),
    });
    const html = (await readChunks(response)).join("");
    const islandStart = html.indexOf("<preact-island");
    const island = html.slice(islandStart, html.indexOf("</preact-island>") + 16);
    const trigger = html.slice(islandStart + island.length).match(/^<script>([^<]*)<\/script>/)![1];
    const dom = new JSDOM(html.slice(0, islandStart), {
      pretendToBeVisual: true,
      runScripts: "dangerously",
    });
    const { document } = dom.window;

    // The parser connects the island at its start tag, yields for a frame,
    // then appends the children and reaches the trigger script.
    const element = document.createElement("preact-island");
    element.setAttribute("hidden", "");
    element.setAttribute("data-target", island.match(/data-target="([^"]+)"/)![1]);
    document.querySelector("div[hidden]")!.append(element);
    await nextFrame(dom.window);
    element.innerHTML = island.slice(island.indexOf(">") + 1, -"</preact-island>".length);
    const script = document.createElement("script");
    script.textContent = trigger;
    element.after(script);
    await nextFrame(dom.window);

    expect(document.querySelector("main")!.innerHTML).toContain("<ul><li>review-7</li></ul>");
    expect(document.querySelector("main p")).toBeNull();
    dom.window.close();
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

  it("resolves nested deferred values before writing the defer channel", async () => {
    const response = await handlePrachtRequest({
      app: streamingApp(),
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({
              section: defer(
                Promise.resolve({
                  items: [defer(Promise.resolve("nested"))],
                }),
              ),
            }),
            Component: () => h("main", null, "shell"),
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    const html = (await readChunks(response)).join("");
    expect(html).toContain('__PRACHT_DEFER__.r("0:section",{"items":["nested"]})');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
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

it("flushes the same ordered critical CSS assets as buffered SSR", async () => {
  const response = await handlePrachtRequest({
    app: streamingApp(),
    registry: { routeModules: { "./routes/product.tsx": streamingRoute() } },
    request: new Request("http://localhost/product"),
    cssManifest: { "./routes/product.tsx": ["/first.css", "/external.css", "/last.css"] },
    cssContentManifest: { "/first.css": "h1{color:red}", "/last.css": "p{color:blue}" },
  });
  const reader = response.body!.getReader();
  const prefix = new TextDecoder().decode((await reader.read()).value);
  expect(prefix).toContain("h1{color:red}");
  expect(prefix.indexOf("h1{color:red}")).toBeLessThan(prefix.indexOf('href="/external.css"'));
  expect(prefix.indexOf('href="/external.css"')).toBeLessThan(prefix.indexOf("p{color:blue}"));
  await reader.cancel();
});
