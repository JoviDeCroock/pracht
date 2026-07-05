import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Dev-only 404 page: unmatched document navigations render a standalone HTML
// page listing every registered route with its render mode. Runs against the
// pages-router example (node adapter) — the Cloudflare example owns its dev
// server, so the pracht dev middleware is not active there.
// ---------------------------------------------------------------------------

test("unmatched navigation renders the dev 404 page with the route table", async ({ page }) => {
  const response = await page.goto("/this/route/does/not/exist");
  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-type"]).toContain("text/html");

  await expect(page.locator(".badge")).toHaveText("404");
  await expect(page.locator(".message")).toContainText("/this/route/does/not/exist");

  // Every registered page route is listed with its render mode.
  await expect(page.locator('a.path[href="/about"]')).toHaveText("/about");
  await expect(page.locator(".path.dynamic")).toContainText("/blog/:slug");
  await expect(page.locator(".mode-ssg").first()).toBeVisible();

  // API routes are listed too.
  await expect(page.locator("td", { hasText: "/api/health" })).toBeVisible();
});

test("dev 404 links navigate to real routes", async ({ page }) => {
  await page.goto("/missing-page");
  await page.click('a.path[href="/about"]');

  await expect(page.locator("h1")).toContainText("About");
});

test("unmatched route-state requests keep their JSON 404 behavior", async ({ request }) => {
  const response = await request.get("/missing-page?_data=1", {
    headers: { accept: "*/*" },
  });

  expect(response.status()).toBe(404);
  const body = await response.text();
  expect(body).not.toContain("No route matches");
});
