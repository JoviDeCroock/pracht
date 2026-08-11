import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { e2eExampleDirectory } from "./ports.ts";

const islandsExampleDir = e2eExampleDirectory("islands");

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
  const fullHydrationMarker = await page.locator("html").getAttribute("data-pracht-hydrated");
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

// Routes without full hydration are excluded from the client bundle. Content
// scanners such as Tailwind still register their source files as file-only
// assets in Vite's client graph, but those watch entries cannot update the
// rendered HTML. The plugin has to reload the page itself.
test("editing a hydration islands route reloads the open page with CSS scanning active", async ({
  page,
}) => {
  test.setTimeout(30_000);

  const routeFile = resolve(islandsExampleDir, "src/routes/home.tsx");
  const original = readFileSync(routeFile, "utf-8");

  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Islands architecture");

  try {
    writeFileSync(routeFile, original.replace("Islands architecture", "Edited islands in dev"));
    await expect(page.locator("h1")).toHaveText("Edited islands in dev", { timeout: 15_000 });
  } finally {
    writeFileSync(routeFile, original);
  }

  await expect(page.locator("h1")).toHaveText("Islands architecture", { timeout: 15_000 });
});

test("editing a hydration none route reloads the open page", async ({ page }) => {
  test.setTimeout(30_000);

  const routeFile = resolve(islandsExampleDir, "src/routes/static-page.tsx");
  const original = readFileSync(routeFile, "utf-8");

  await page.goto("/static");
  await expect(page.locator("h1")).toHaveText("Fully static");

  try {
    writeFileSync(routeFile, original.replace("Fully static", "Edited in dev"));
    await expect(page.locator("h1")).toHaveText("Edited in dev", { timeout: 15_000 });
  } finally {
    writeFileSync(routeFile, original);
  }

  await expect(page.locator("h1")).toHaveText("Fully static", { timeout: 15_000 });
});

test("editing an island keeps client state while file-only asset entries exist", async ({
  page,
}) => {
  test.setTimeout(30_000);

  const islandFile = resolve(islandsExampleDir, "src/islands/Counter.tsx");
  const original = readFileSync(islandFile, "utf-8");

  await page.goto("/");
  await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
  await page.getByTestId("increment").click();
  await expect(page.getByTestId("count")).toHaveText("Count: 6");

  try {
    writeFileSync(islandFile, original.replace("Increment", "Increment updated"));
    await expect(page.getByTestId("increment")).toHaveText("Increment updated", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("count")).toHaveText("Count: 6");
  } finally {
    writeFileSync(islandFile, original);
  }

  await expect(page.getByTestId("increment")).toHaveText("Increment", { timeout: 15_000 });
  await expect(page.getByTestId("count")).toHaveText("Count: 6");
});
