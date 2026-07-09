import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

// Navigation UX primitives: useNavigation() pending state, scroll
// restoration, <Link prefetch>, and View Transitions. Runs against the
// examples/cloudflare dev server (see playwright.config.ts "basic" project).

async function waitForRouter(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
}

function isRouteStateRequestFor(request: Request, pathname: string): boolean {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  return url.pathname === pathname && request.headers()["x-pracht-route-state-request"] === "1";
}

// ---------------------------------------------------------------------------
// useNavigation(): pending state during a slow loader navigation
// ---------------------------------------------------------------------------

test("useNavigation exposes loading state while a slow loader navigation is in flight", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRouter(page);

  await expect(page.locator("#nav-status")).toHaveAttribute("data-state", "idle");

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click("#slow-link");

  // The slow route's loader takes ~600ms — the pending state (including the
  // target location) must be observable in the meantime.
  await page.locator('#nav-status[data-state="loading"][data-target="/slow"]').waitFor();

  await page.waitForURL("/slow");
  await expect(page.locator("h1")).toContainText("Slow page");
  await expect(page.locator("#nav-status")).toHaveAttribute("data-state", "idle");

  // Still a client-side navigation
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// Scroll restoration
// ---------------------------------------------------------------------------

test("forward navigation scrolls to top and back navigation restores the scroll position", async ({
  page,
}) => {
  await page.goto("/long");
  await waitForRouter(page);

  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForFunction(() => window.scrollY === 1500);

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/"));
  await page.waitForURL("/");
  await page.waitForFunction(() => window.scrollY === 0);

  await page.goBack();
  await page.waitForURL("/long");
  await page.waitForFunction(() => window.scrollY === 1500);
});

test("navigate with preserveScroll keeps the current scroll position", async ({ page }) => {
  await page.goto("/long");
  await waitForRouter(page);

  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForFunction(() => window.scrollY === 1200);

  // /slow is also tall, so after commit preserveScroll must keep the exact
  // scroll position instead of resetting to the top.
  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/slow", { preserveScroll: true }));
  await page.waitForURL("/slow");
  await expect(page.locator("h1")).toContainText("Slow page");

  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY).toBe(1200);
});

// ---------------------------------------------------------------------------
// <Link prefetch>
// ---------------------------------------------------------------------------

test("hover prefetch fires exactly one route-state request and navigation reuses it", async ({
  page,
}) => {
  const pricingRouteStateRequests: string[] = [];
  page.on("request", (request) => {
    if (isRouteStateRequestFor(request, "/pricing")) {
      pricingRouteStateRequests.push(request.url());
    }
  });

  await page.goto("/");
  await waitForRouter(page);

  const prefetchRequest = page.waitForRequest((request) =>
    isRouteStateRequestFor(request, "/pricing"),
  );
  await page.hover("#prefetch-pricing-link");
  const request = await prefetchRequest;
  await (await request.response())?.finished();

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });
  await page.click("#prefetch-pricing-link");
  await page.waitForURL("/pricing");
  await expect(page.locator("h1")).toContainText("MVP plan");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  // The hover prefetch is the only route-state request — the navigation
  // consumed the cached result instead of fetching again.
  expect(pricingRouteStateRequests).toHaveLength(1);
});

test('<Link prefetch="none"> disables intent prefetching for that link', async ({ page }) => {
  const slowRouteStateRequests: string[] = [];
  page.on("request", (request) => {
    if (isRouteStateRequestFor(request, "/slow")) {
      slowRouteStateRequests.push(request.url());
    }
  });

  await page.goto("/");
  await waitForRouter(page);

  await page.hover("#slow-link");
  // Longer than the 50ms intent debounce — nothing may fire.
  await page.waitForTimeout(300);

  expect(slowRouteStateRequests).toHaveLength(0);
});

test('<Link prefetch="viewport"> prefetches when the link scrolls into view', async ({ page }) => {
  const pricingRouteStateRequests: string[] = [];
  page.on("request", (request) => {
    if (isRouteStateRequestFor(request, "/pricing")) {
      pricingRouteStateRequests.push(request.url());
    }
  });

  await page.goto("/long");
  await waitForRouter(page);

  expect(pricingRouteStateRequests).toHaveLength(0);

  const prefetchRequest = page.waitForRequest((request) =>
    isRouteStateRequestFor(request, "/pricing"),
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await prefetchRequest;

  expect(pricingRouteStateRequests).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// View Transitions
// ---------------------------------------------------------------------------

test("<Link viewTransition> navigates client-side in browsers with View Transition support", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRouter(page);

  const supported = await page.evaluate(
    () => typeof (document as any).startViewTransition === "function",
  );

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click("#vt-pricing-link");
  await page.waitForURL("/pricing");
  await expect(page.locator("h1")).toContainText("MVP plan");
  await expect(page.locator("#nav-status")).toHaveAttribute("data-state", "idle");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  // Playwright's bundled Chromium supports the View Transitions API, so the
  // supported path is what this test exercised.
  expect(supported).toBe(true);
});

test("<Link viewTransition> is a graceful no-op in browsers without View Transition support", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (Document.prototype as any).startViewTransition;
  });

  await page.goto("/");
  await waitForRouter(page);

  const supported = await page.evaluate(
    () => typeof (document as any).startViewTransition === "function",
  );
  expect(supported).toBe(false);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click("#vt-pricing-link");
  await page.waitForURL("/pricing");
  await expect(page.locator("h1")).toContainText("MVP plan");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});
