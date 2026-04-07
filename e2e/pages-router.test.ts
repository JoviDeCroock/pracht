import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Pages are discovered and routable
// ---------------------------------------------------------------------------

test("home page renders with loader data via pages router", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");

  // Shell renders
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("header")).toContainText("Previte Pages");
  await expect(page.locator("footer")).toContainText("File-system routing");

  // Route component renders with loader data
  await expect(page.locator("h1")).toContainText("Welcome to previte with file-system routing");
});

test("about page renders as static page", async ({ page }) => {
  await page.goto("/about");

  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("About");
  await expect(page.locator("p")).toContainText("static page rendered with SSG");
});

// ---------------------------------------------------------------------------
// _app.tsx shell wraps all pages
// ---------------------------------------------------------------------------

test("_app shell wraps all pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".pages-shell")).toBeVisible();

  await page.goto("/about");
  await expect(page.locator(".pages-shell")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Dynamic routes ([slug]) capture params
// ---------------------------------------------------------------------------

test("dynamic route captures params", async ({ page }) => {
  await page.goto("/blog/hello-world");

  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Blog: Hello World");
  await expect(page.locator("code")).toContainText("hello-world");
});

test("dynamic route works with different slugs", async ({ page }) => {
  await page.goto("/blog/my-first-post");

  await expect(page.locator("h1")).toContainText("Blog: my first post");
  await expect(page.locator("code")).toContainText("my-first-post");
});

// ---------------------------------------------------------------------------
// Client-side navigation
// ---------------------------------------------------------------------------

test("client-side navigation works between pages", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PREVITE_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to about
  await page.click('a[href="/about"]');
  await page.waitForURL("/about");

  // Token survives — no full reload
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator("h1")).toContainText("About");
});

test("client-side navigation to dynamic route", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PREVITE_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/blog/hello-world"]');
  await page.waitForURL("/blog/hello-world");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator("h1")).toContainText("Blog: Hello World");
});

// ---------------------------------------------------------------------------
// Hydration state
// ---------------------------------------------------------------------------

test("pages include hydration state", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain('id="previte-state" type="application/json"');
  expect(html).toContain("Welcome to previte with file-system routing");
});

// ---------------------------------------------------------------------------
// Route state JSON (client-side navigation data)
// ---------------------------------------------------------------------------

test("route state request returns JSON for pages", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "x-previte-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.message).toContain("file-system routing");
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

test("unmatched route returns 404", async ({ request }) => {
  const response = await request.get("/nonexistent-page");
  expect(response.status()).toBe(404);
});
