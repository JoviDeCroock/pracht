import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// App-level notFound page (`defineApp({ notFound })`). Runs against the
// cloudflare example, which declares one — so the dev-only 404 page steps
// aside and dev renders exactly what production renders.
//
// The point of the design is what it *cannot* do: the not-found page is not a
// route, so it never matches a URL and therefore can never shadow a static
// asset or a route registered later.
// ---------------------------------------------------------------------------

test("unmatched navigation renders the app notFound page with a 404 status", async ({ page }) => {
  const response = await page.goto("/this/page/does/not/exist");

  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.locator("#not-found h1")).toContainText("404");
  await expect(page.locator("#requested-path")).toHaveText("/this/page/does/not/exist");
  // Rendered inside the configured shell, like any other page.
  await expect(page.locator(".public-shell header")).toBeVisible();
});

test("the notFound page hydrates and navigates like a normal page", async ({ page }) => {
  await page.goto("/nope");
  await page.locator("html[data-pracht-hydrated]").waitFor();

  await page.click("#not-found a");
  await expect(page.locator("h1")).not.toContainText("404");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("static assets are served instead of the notFound page", async ({ request }) => {
  const response = await request.get("/robots.txt");

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("User-agent");
});

test("existing routes are unaffected", async ({ page }) => {
  const response = await page.goto("/pricing");
  expect(response?.status()).toBe(200);
});

test("route-state requests for unmatched paths stay JSON", async ({ request }) => {
  const response = await request.get("/nope", {
    headers: { accept: "*/*", "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.text()).not.toContain("<h1>");
});
