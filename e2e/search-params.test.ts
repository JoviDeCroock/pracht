import { expect, test } from "@playwright/test";

/**
 * Typed search params in examples/basic: /catalog exports a `search` schema
 * that coerces `page` to a positive integer with a default of 1. The loader,
 * head(), and useSearch() all see the parsed value, typed <Link search>
 * builds the next page's URL, and a query the schema rejects answers 400
 * through the route's error boundary.
 */
test("server render parses the query before the loader and head() read it", async ({ request }) => {
  const response = await request.get("/catalog?page=2");

  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("<title>Catalog — page 2</title>");
  expect(html).toContain("page=2 (number)");
  // Page 2 of the nine items, three per page.
  expect(html).toContain("Drill");
  expect(html).not.toContain("Anvil");
});

test("schema defaults make the bare URL valid", async ({ request }) => {
  const response = await request.get("/catalog");

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("page=1 (number)");
});

test("a rejected query answers 400 through the route error boundary", async ({ request }) => {
  const response = await request.get("/catalog?page=0");

  expect(response.status()).toBe(400);
  const html = await response.text();
  expect(html).toContain("400 Invalid search params");
  expect(html).toContain('data-testid="catalog-issue"');
});

test("client navigation follows typed links and re-parses the query", async ({ page }) => {
  await page.goto("/catalog?q=a");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await expect(page.getByTestId("catalog-search")).toHaveText("page=1 (number) q=a");

  // Mark the document so a full reload would be detected.
  await page.evaluate(() => ((window as any).__catalogDocument = true));

  const next = page.getByTestId("catalog-next");
  await expect(next).toHaveAttribute("href", "/catalog?page=2&q=a");
  await next.click();

  await expect(page).toHaveURL("/catalog?page=2&q=a");
  await expect(page.getByTestId("catalog-search")).toHaveText("page=2 (number) q=a");
  await expect(page.getByTestId("catalog-items")).toContainText("Hammer");
  expect(await page.evaluate(() => (window as any).__catalogDocument)).toBe(true);
});

test("client navigation to a rejected query renders the error boundary", async ({ page }) => {
  await page.goto("/catalog");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/catalog?page=-3"));

  await expect(page.getByTestId("catalog-error")).toHaveText("400 Invalid search params");
  await expect(page.getByTestId("catalog-issue")).toContainText("page:");
});
