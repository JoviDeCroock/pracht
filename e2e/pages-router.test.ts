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

test("@-prefixed static routes render in dev", async ({ page }) => {
  const response = await page.goto("/@alice");

  expect(response?.status()).toBe(200);
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("@alice");
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

test("dotted dynamic routes render in dev", async ({ page }) => {
  const response = await page.goto("/blog/release-1.2.3");

  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Blog: release 1.2.3");
  await expect(page.locator("code")).toContainText("release-1.2.3");
});

test("asset-looking dynamic routes still render as pages in dev", async ({ page }) => {
  const response = await page.goto("/blog/openapi.json");

  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Blog: openapi.json");
  await expect(page.locator("code")).toContainText("openapi.json");
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

test("typed Link, href helper, and route-object navigation work in pages-router apps", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await expect(page.locator('a[href="/blog/hello-world?ref=typed-link"]')).toContainText(
    "Read typed blog post",
  );
  await expect(page.locator('a[href="/about?tab=details"]')).toContainText("About via href()");

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/blog/hello-world?ref=typed-link"]');
  await page.waitForURL("/blog/hello-world?ref=typed-link");
  await expect(page.locator("h1")).toContainText("Blog: Hello World");

  await page.goBack();
  await page.waitForURL("/");
  await page.click("#typed-blog-button");
  await page.waitForURL("/blog/my-first-post");
  await expect(page.locator("h1")).toContainText("Blog: my first post");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
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

test("route state _data requests work for dotted slugs in dev", async ({ request }) => {
  const response = await request.get("/blog/openapi.json?_data=1");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const json = await response.json();
  expect(json.data).toMatchObject({
    slug: "openapi.json",
    title: "Blog: openapi.json",
  });
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

// ---------------------------------------------------------------------------
// Dev devtools: /_pracht + Server-Timing
// ---------------------------------------------------------------------------

test("/_pracht serves the devtools page in dev", async ({ request }) => {
  const response = await request.get("/_pracht");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");

  const html = await response.text();
  expect(html).toContain("pracht");
  expect(html).toContain("/about");
  expect(html).toContain("/blog/:slug");
  expect(html).toContain("/api/health");
  expect(html).toContain("/_pracht.json");
});

test("/_pracht.json serves the resolved app graph as JSON", async ({ request }) => {
  const response = await request.get("/_pracht.json");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const graph = await response.json();
  const routePaths = graph.routes.map((route: { path: string }) => route.path);
  expect(routePaths).toContain("/");
  expect(routePaths).toContain("/about");
  expect(routePaths).toContain("/blog/:slug");

  const health = graph.api.find((route: { path: string }) => route.path === "/api/health");
  expect(health.methods).toContain("GET");
  expect(health.file).toContain("health");
});

test("dev SSR responses carry a Server-Timing header with phase durations", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);

  const serverTiming = response.headers()["server-timing"];
  expect(serverTiming).toMatch(/mw;dur=\d+(\.\d+)?/);
  expect(serverTiming).toMatch(/loader;dur=\d+(\.\d+)?/);
  expect(serverTiming).toMatch(/render;dur=\d+(\.\d+)?/);
});
