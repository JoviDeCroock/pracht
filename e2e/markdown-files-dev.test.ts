import { expect, test } from "@playwright/test";

// Runs against the examples/basic dev server (the "capabilities" project),
// which owns its dev server and enables `llmsTxt`.

test("GET /index.md serves the home page's markdown export in dev", async ({ request }) => {
  const response = await request.get("/index.md");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect((await response.text()).startsWith("# Pracht Example\n")).toBe(true);

  // The products route negotiates through middleware: no file, in dev or build.
  const product = await request.get("/products/1.md");
  expect(product.headers()["content-type"] ?? "").not.toContain("text/markdown");

  const llmsTxt = await (await request.get("/llms.txt")).text();
  expect(llmsTxt).toContain("- [/](/index.md): Markdown version of `/`");
  expect(llmsTxt).toContain("- [/products/1](/products/1): supports `Accept: text/markdown`");
});
