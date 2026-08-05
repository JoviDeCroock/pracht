import { expect, test } from "@playwright/test";

test("OpenAPI JSON is generated from the live API graph", async ({ request }) => {
  const response = await request.get("/openapi.json");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toBe("no-store");

  const document = await response.json();
  expect(document).toMatchObject({
    openapi: "3.1.0",
    info: { title: "Pracht Pages Example API", version: "1.0.0" },
    paths: {
      "/api/health": {
        get: {
          responses: {
            default: { description: "Response contract is not documented." },
          },
        },
      },
    },
  });
});

test("OpenAPI reference UI points at the generated JSON", async ({ request }) => {
  const response = await request.get("/docs");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");

  const html = await response.text();
  expect(html).toContain("Scalar.createApiReference");
  expect(html).toContain('{"url":"/openapi.json"}');
  expect(html).toContain("@scalar/api-reference@1.64.0");
});

test("OpenAPI endpoints allow only safe read methods", async ({ request }) => {
  const head = await request.head("/openapi.json");
  expect(head.status()).toBe(200);
  expect(await head.body()).toEqual(Buffer.from([]));

  const post = await request.post("/openapi.json");
  expect(post.status()).toBe(405);
  expect(post.headers().allow).toBe("GET, HEAD");
});
