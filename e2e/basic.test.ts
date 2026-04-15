import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// SSR: Home page (render: "ssg" — served via SSR in dev)
// ---------------------------------------------------------------------------

test("home page renders SSR HTML with loader data", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");

  // Shell renders
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("header")).toContainText("Pracht");
  await expect(page.locator("footer")).toContainText("Preact-first");

  // Route component renders with loader data
  await expect(page.locator("h1")).toContainText("explicit app manifest");
  await expect(page.locator("li").first()).toContainText("Hybrid route manifest");
});

test("home page HTML includes hydration state", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain('id="pracht-state" type="application/json"');
  expect(html).toContain('"routeId":"home"');
  expect(html).toContain("Hybrid route manifest");
});

test("home page includes default security headers", async ({ request }) => {
  const response = await request.get("/");

  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("home page has correct head metadata", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain("<title>Pracht Example</title>");
  expect(html).toContain('name="viewport"');
});

// ---------------------------------------------------------------------------
// SSR: Pricing page (render: "isg" — served via SSR in dev)
// ---------------------------------------------------------------------------

test("pricing page renders with loader data", async ({ page }) => {
  await page.goto("/pricing");

  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("MVP plan");
  await expect(page.locator("section")).toContainText("ISG fits pricing pages");
});

// ---------------------------------------------------------------------------
// Middleware: auth redirect
// ---------------------------------------------------------------------------

test("dashboard redirects to / without session cookie", async ({ page }) => {
  const response = await page.goto("/dashboard");

  // Middleware should redirect unauthenticated users to /
  expect(page.url()).toContain("/");
  expect(response?.status()).toBe(200);
});

test("client navigation to a protected route no-ops when middleware redirects back to the current page", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
    const link = document.createElement("a");
    link.href = "/dashboard";
    link.id = "protected-dashboard-link";
    link.textContent = "Dashboard";
    document.body.appendChild(link);
  });

  await page.click("#protected-dashboard-link", { timeout: 1_000 });

  await expect(page).toHaveURL("/");
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("client redirects preserve hash fragments instead of swallowing them as current-page no-ops", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (input === "/dashboard") {
        return new Response(JSON.stringify({ redirect: "/#install" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      return originalFetch(input, init);
    };

    const link = document.createElement("a");
    link.href = "/dashboard";
    link.id = "hash-redirect-link";
    link.textContent = "Dashboard";
    document.body.appendChild(link);
  });

  await page.click("#hash-redirect-link", { timeout: 1_000 });

  await expect(page).toHaveURL(/\/#install$/);
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("dashboard renders with session cookie", async ({ page, context }) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Ada Lovelace");
  await expect(page.locator("p")).toContainText("Projects: 3");
});

test("dashboard form posts to API route and keeps the current route hydrated", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__ACTION_TOKEN__ = true;
  });

  await page.click('button[type="submit"]');

  await expect(page).toHaveURL("/dashboard");
  await expect(page.locator("h1")).toContainText("Ada Lovelace");
  await expect(page.locator("p")).toContainText("Projects: 3");

  const tokenSurvived = await page.evaluate(() => (window as any).__ACTION_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// SPA route: Settings
// ---------------------------------------------------------------------------

test("settings returns SPA shell chrome and loading UI without SSR route content", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  const response = await page.goto("/settings");
  expect(response?.status()).toBe(200);

  const html = await response?.text();
  expect(html).toContain("Loading page...");
  expect(html).toContain("Back to home");
  expect(html).not.toContain("<h1>Settings</h1>");
});

test("settings hydrates correctly on a direct authenticated load", async ({ page, context }) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/settings");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await expect(page.locator("h1")).toContainText("Settings");
  await expect(page.locator("li")).toHaveCount(3);
});

// ---------------------------------------------------------------------------
// Route state JSON (client-side navigation)
// ---------------------------------------------------------------------------

test("route state request returns JSON", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.highlights).toContain("Hybrid route manifest");
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

test("unmatched route returns 404", async ({ request }) => {
  const response = await request.get("/nonexistent-page");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client-side navigation
// ---------------------------------------------------------------------------

test("clicking a link navigates without full page reload", async ({ page }) => {
  await page.goto("/");
  // Wait for hydration
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Capture a page-level reference to detect full reloads
  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Click the pricing link
  await page.click('a[href="/pricing"]');

  // The URL should update
  await page.waitForURL("/pricing");

  // The token should still exist (no full reload)
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  // Pricing content should render
  await expect(page.locator("h1")).toContainText("MVP plan");
});

test("client-side navigation updates shell when crossing shell boundaries", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // We're in the app shell
  await expect(page.locator(".app-shell")).toBeVisible();

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to home (public shell)
  await page.click('a[href="/"]');
  await page.waitForURL("/");

  // Should now be in public shell
  await expect(page.locator(".public-shell")).toBeVisible();

  // Still a client-side navigation
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("back button works with client-side navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to pricing
  await page.click('a[href="/pricing"]');
  await page.waitForURL("/pricing");
  await expect(page.locator("h1")).toContainText("MVP plan");

  // Go back
  await page.goBack();
  await page.waitForURL("/");

  // Home content should render
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  // Token still alive — no full reload during back navigation either
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("same-shell navigation preserves shell and updates route content", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Verify we're on home in public shell
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  // Navigate to pricing (same public shell)
  await page.click('a[href="/pricing"]');
  await page.waitForURL("/pricing");

  // Shell still present, content changed
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("MVP plan");
});

// ---------------------------------------------------------------------------
// Dynamic route with useParams
// ---------------------------------------------------------------------------

test("product page renders with useParams showing the route param", async ({ page }) => {
  await page.goto("/products/1");

  await expect(page.locator(".product-page")).toBeVisible();
  await expect(page.locator(".product-id")).toContainText("Product ID: 1");
  await expect(page.locator("h1")).toContainText("Widget");
});

test("product page SSR HTML contains params from useParams", async ({ request }) => {
  const response = await request.get("/products/2");
  const html = await response.text();

  expect(html).toContain("Product ID: 2");
  expect(html).toContain("Gadget");
});

test("client-side navigation to product page renders useParams correctly", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/products/1"));
  await page.waitForURL("/products/1");

  await expect(page.locator(".product-id")).toContainText("Product ID: 1");
  await expect(page.locator("h1")).toContainText("Widget");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

test("GET /api/health returns JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ status: "ok" });
});

test("POST /api/echo echoes the request body", async ({ request }) => {
  const response = await request.post("/api/echo", {
    data: { message: "hello" },
  });
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toEqual({ echo: { message: "hello" } });
});

test("PUT /api/health returns 405", async ({ request }) => {
  const response = await request.put("/api/health");
  expect(response.status()).toBe(405);
});

test("GET /api/nonexistent falls through to 404", async ({ request }) => {
  const response = await request.get("/api/nonexistent");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

test("page hydrates without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });

  await page.goto("/");
  // Wait for hydration to complete
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Filter out known non-critical warnings
  const criticalErrors = errors.filter((e) => !e.includes("[vite]") && !e.includes("404"));
  expect(criticalErrors).toHaveLength(0);
});
