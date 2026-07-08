import { expect, test } from "@playwright/test";

// Dev-server coverage for islands routes: the vite plugin serves the islands
// bootstrap from /@pracht/islands.js and the dev SSR middleware renders the
// island markers exactly like production.

test("counter island hydrates and is interactive in dev", async ({ page }) => {
  test.setTimeout(20_000);

  await page.goto("/");
  await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');

  await expect(page.getByTestId("count")).toHaveText("Count: 5");
  await page.getByTestId("increment").click();
  await expect(page.getByTestId("count")).toHaveText("Count: 6");
});

test("non-island server components do not hydrate on islands routes", async ({ page }) => {
  test.setTimeout(20_000);

  await page.goto("/");
  await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');

  await page.getByTestId("dead-button").click();
  await page.waitForTimeout(250);
  await expect(page.getByTestId("dead-button")).toHaveText("static");

  // The full client runtime never loads on islands routes, so the regular
  // hydration marker must not appear.
  const fullHydrationMarker = await page
    .locator("html")
    .getAttribute("data-pracht-hydrated");
  expect(fullHydrationMarker).toBeNull();
});

test("visible islands hydrate only after scrolling into view", async ({ page }) => {
  test.setTimeout(20_000);

  await page.goto("/lazy");
  await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');

  const lazyIsland = page.locator('pracht-island[island="/src/islands/LazyBox.tsx"]');
  await expect(lazyIsland).not.toHaveAttribute("data-hydrated", "true");

  await page.getByTestId("reveal").scrollIntoViewIfNeeded();
  await expect(lazyIsland).toHaveAttribute("data-hydrated", "true");

  await page.getByTestId("reveal").click();
  await expect(page.getByTestId("revealed")).toHaveText("Hydrated below the fold!");
});

test("hydration none routes render without islands bootstrap or state", async ({ page }) => {
  test.setTimeout(20_000);

  const response = await page.goto("/static");
  const html = (await response?.text()) ?? "";

  expect(html).not.toContain("pracht-island");
  expect(html).not.toContain('id="pracht-state"');
  expect(html).not.toContain("/@pracht/islands.js");
  expect(html).not.toContain("/@pracht/client.js");
  await expect(page.locator("h1")).toHaveText("Fully static");
});
