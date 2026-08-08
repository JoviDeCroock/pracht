import { expect, test } from "@playwright/test";

test("Cloudflare dev serves OpenAPI without evaluating worker modules in Node", async ({
  request,
}) => {
  const response = await request.get("/openapi.json");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const document = await response.json();
  expect(document).toMatchObject({
    openapi: "3.1.0",
    info: { title: "Pracht Cloudflare Example API", version: "1.0.0" },
  });
  expect(document.paths["/api/health"].get).toBeDefined();
});

test("Cloudflare dev serves the configured OpenAPI UI", async ({ request }) => {
  const response = await request.get("/docs");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  expect(await response.text()).toContain('{"url":"/openapi.json"}');
});
