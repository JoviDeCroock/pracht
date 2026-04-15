import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Pages are discovered and routable
// ---------------------------------------------------------------------------

test("home page renders with loader data via pages router", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  expect(response?.headers()["x-pracht-router"]).toBe("pages");

  // Shell renders
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("header")).toContainText("Pracht Pages");
  await expect(page.locator("footer")).toContainText("File-system routing");

  // Route component renders with loader data
  await expect(page.locator("h1")).toContainText("Welcome to pracht with file-system routing");
});

test("about page renders as static page", async ({ page }) => {
  await page.goto("/about");

  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("About");
  await expect(page.locator("section p").first()).toContainText("static page rendered with SSG");
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
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

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

test("client-side navigation preserves query strings and exposes search separately", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/about?tab=details"));
  await page.waitForURL("/about?tab=details");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator(".location-pathname")).toContainText("/about");
  await expect(page.locator(".location-search")).toContainText("?tab=details");
});

test("client-side navigation to dynamic route", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

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

  expect(html).toContain('id="pracht-state" type="application/json"');
  expect(html).toContain("Welcome to pracht with file-system routing");
});

test("page routes tolerate dotted query strings", async ({ request }) => {
  const response = await request.get(
    "/?shop=test-shop.myshopify.com&id_token=header.payload.signature",
  );

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");

  const html = await response.text();
  expect(html).toContain("Welcome to pracht with file-system routing");
});

// ---------------------------------------------------------------------------
// Route state JSON (client-side navigation data)
// ---------------------------------------------------------------------------

test("route state request returns JSON for pages", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()["x-pracht-router"]).toBeUndefined();
  const json = await response.json();
  expect(json.data.message).toContain("file-system routing");
});

// ---------------------------------------------------------------------------
// API routes & HOF middleware
// ---------------------------------------------------------------------------

test("GET /api/health returns JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ status: "ok" });
});

test("GET /api/me without session returns 401", async ({ request }) => {
  const response = await request.get("/api/me");
  expect(response.status()).toBe(401);

  const json = await response.json();
  expect(json).toMatchObject({ error: "Unauthorized" });
});

test("GET /api/me with session cookie returns user", async ({ request }) => {
  const response = await request.get("/api/me", {
    headers: { cookie: "session=abc123" },
  });
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ user: "Alice" });
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

test("unmatched route returns 404", async ({ request }) => {
  const response = await request.get("/nonexistent-page");
  expect(response.status()).toBe(404);
});
