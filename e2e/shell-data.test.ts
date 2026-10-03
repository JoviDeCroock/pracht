import { expect, test, type Page, type Request } from "@playwright/test";

// examples/cloudflare's `app` shell exports a loader returning the signed-in
// user plus a `loadId` that changes every time the loader runs, which is what
// makes "was the shell loader run again?" observable from the browser.

const SESSION_COOKIE = { name: "session", value: "abc123", domain: "localhost", path: "/" };

async function shellLoadId(page: Page): Promise<string> {
  return (await page.locator(".shell-load-id").textContent()) ?? "";
}

function isRouteStateRequest(request: Request, pathname: string): boolean {
  return (
    new URL(request.url()).pathname === pathname &&
    request.headers()["x-pracht-route-state-request"] === "1"
  );
}

test("server-renders shell loader data for the shell and the route", async ({ page, context }) => {
  await context.addCookies([SESSION_COOKIE]);

  const response = await page.goto("/dashboard");
  const html = (await response?.text()) ?? "";

  expect(html).toContain('<span class="shell-user">Ada Lovelace</span>');
  expect(html).toMatch(/"shellData":\{[^}]*"user":"Ada Lovelace"/);

  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await expect(page.locator(".shell-user")).toHaveText("Ada Lovelace");
  await expect(page.locator(".route-shell-user")).toHaveText("Signed in as Ada Lovelace");
});

test("does not refetch shell data on a navigation that stays in the shell", async ({
  page,
  context,
}) => {
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  const initialLoadId = await shellLoadId(page);
  expect(initialLoadId).not.toBe("");

  const settingsState = page.waitForRequest((request) => isRouteStateRequest(request, "/settings"));
  await page.click('nav a[href="/settings"]');
  const request = await settingsState;
  await expect(page.locator("h1")).toHaveText("Settings");

  // The request claims the shell it already holds, so the server skips the
  // shell loader and leaves its data out.
  expect(request.headers()["x-pracht-shell-data"]).toBe("app");
  const body = (await (await request.response())!.json()) as Record<string, unknown>;
  expect(body).not.toHaveProperty("shellData");
  expect(body.data).toEqual({ sections: ["Profile", "Notifications", "Teams"] });

  expect(await shellLoadId(page)).toBe(initialLoadId);
  await expect(page.locator(".route-shell-user")).toHaveText("Signed in as Ada Lovelace");
});

test("fetches the new shell's data when a navigation enters the shell", async ({
  page,
  context,
}) => {
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/dashboard";
    link.id = "enter-app-shell";
    link.textContent = "Dashboard";
    document.body.appendChild(link);
  });
  const dashboardState = page.waitForRequest((request) =>
    isRouteStateRequest(request, "/dashboard"),
  );
  await page.click("#enter-app-shell");
  const request = await dashboardState;

  expect(request.headers()["x-pracht-shell-data"]).toBeUndefined();
  await expect(page.locator(".shell-user")).toHaveText("Ada Lovelace");
  expect(await shellLoadId(page)).not.toBe("");
});

test("revalidation refreshes shell data along with route data", async ({ page, context }) => {
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  const initialLoadId = await shellLoadId(page);

  const revalidation = page.waitForRequest(
    (request) =>
      isRouteStateRequest(request, "/dashboard") && !request.headers()["x-pracht-shell-data"],
  );
  await page.click('button:has-text("Revalidate dashboard")');
  await revalidation;

  await expect.poll(() => shellLoadId(page)).not.toBe(initialLoadId);
  await expect(page.locator(".shell-user")).toHaveText("Ada Lovelace");
});
