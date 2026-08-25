import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  Suspense,
  defer,
  defineApp,
  handlePrachtRequest,
  notFound,
  prerenderApp,
  route,
  use,
} from "../src/index.ts";
import { ROUTE_STATE_REQUEST_HEADER } from "../src/runtime-constants.ts";

interface Review {
  id: number;
}

function later<T>(value: T, ms = 5): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** A route whose loader awaits one field and defers another. */
function reviewsRoute(onLoad?: () => void) {
  return async () => ({
    loader: async () => {
      onLoad?.();
      return {
        product: { name: "Widget" },
        reviews: defer(later<Review[]>([{ id: 7 }])),
      };
    },
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

function ReviewList({ reviews }: { reviews: Review[] }) {
  const list = use(reviews);
  return h(
    "ul",
    null,
    list.map((review) => h("li", { key: review.id }, `review-${review.id}`)),
  );
}

function parseHydrationState(html: string) {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Hydration state script not found");
  return JSON.parse(match[1]) as { data: { reviews: Review[] } };
}

describe("defer() through the SSR document path", () => {
  it("renders the resolved value rather than the Suspense fallback", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: { routeModules: { "./routes/product.tsx": reviewsRoute() } },
      request: new Request("http://localhost/product"),
    });

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("review-7");
    expect(html).not.toContain(">loading<");
  });

  it("serializes the resolved value into the hydration state, not a marker", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: { routeModules: { "./routes/product.tsx": reviewsRoute() } },
      request: new Request("http://localhost/product"),
    });

    const state = parseHydrationState(await response.text());
    expect(state.data.reviews).toEqual([{ id: 7 }]);
  });

  it("surfaces a deferred rejection as a normal route error", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({ reviews: defer(Promise.reject(new Error("upstream 500"))) }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    // Until the response streams, a deferred rejection is still inside the
    // pre-flush window, so it produces a real error document rather than an
    // in-boundary error.
    expect(response.status).toBe(500);
  });

  it("does not turn a Response rejected by deferred work into a redirect", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({
              reviews: defer(
                Promise.reject(
                  new Response(null, {
                    status: 302,
                    headers: {
                      location: "/login",
                    },
                  }),
                ),
              ),
            }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not let deferred work choose an HTTP error status", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({
              reviews: defer(Promise.reject(notFound("late missing"))),
            }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/product"),
    });

    expect(response.status).toBe(500);
  });
});

describe("defer() through the route-state path", () => {
  it("returns resolved values so client navigation matches SSR", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: { routeModules: { "./routes/product.tsx": reviewsRoute() } },
      request: new Request("http://localhost/product", {
        headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
      }),
    });

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { data: { reviews: Review[] } };
    expect(body.data.reviews).toEqual([{ id: 7 }]);
  });

  it("rejects a deferred marker hidden behind a getter instead of returning an empty object", async () => {
    const reviews = defer(Promise.resolve<Review[]>([{ id: 7 }]));
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            loader: async () => ({
              get reviews() {
                return reviews;
              },
            }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/product", {
        headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
      }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain(
      "Return defer() from an enumerable data property, not from a getter",
    );
  });
});

describe("defer() under prerendering", () => {
  it("resolves everything at build time — a static file cannot stream", async () => {
    const app = defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssg" })],
    });

    const [page] = await prerenderApp({
      app,
      clientEntryUrl: "/assets/client.js",
      registry: { routeModules: { "/src/routes/product.tsx": reviewsRoute() } },
    });

    expect(page.html).toContain("review-7");
    expect(page.html).not.toContain(">loading<");
  });
});
