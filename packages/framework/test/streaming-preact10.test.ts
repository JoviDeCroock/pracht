import { h } from "preact";
import { expect, it, vi } from "vitest";

// Preact 10's base Component owns only `props` and `context`; Preact 11 adds
// private fields. The server reads that shape to place the client entry.
vi.mock("preact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact")>()),
  Component: function Component(this: Record<string, unknown>, props: unknown, context: unknown) {
    this.props = props;
    this.context = context;
  },
}));

const { Suspense, defer, defineApp, handlePrachtRequest, route, use } =
  await import("../src/index.ts");

function Reviews({ reviews }: { reviews: string }) {
  return h("p", null, use(reviews));
}

it("keeps the client entry at the end of a streamed document on Preact 10", async () => {
  const response = await handlePrachtRequest({
    app: defineApp({
      routes: [route("/product", "./routes/product.tsx", { render: "ssr", streaming: true })],
    }),
    clientEntryUrl: "/assets/client.js",
    registry: {
      routeModules: {
        "./routes/product.tsx": async () => ({
          loader: async () => ({
            reviews: defer(new Promise((resolve) => setTimeout(() => resolve("review-7"), 10))),
          }),
          Component: ({ data }: { data: { reviews: string } }) =>
            h(
              Suspense as never,
              { fallback: h("p", null, "loading") },
              h(Reviews, { reviews: data.reviews }),
            ),
        }),
      },
    },
    request: new Request("http://localhost/product"),
  });

  // Preact 10 resumes against fallback nodes the renderer later replaces, so
  // hydration must not start before every boundary has arrived.
  const html = await response.text();
  const entryIndex = html.indexOf('<script type="module" src="/assets/client.js"></script>');
  expect(entryIndex).toBeGreaterThan(html.indexOf("review-7"));
  expect(entryIndex).toBeLessThan(html.indexOf("</body>"));
});
