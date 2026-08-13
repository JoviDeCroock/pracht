import { expect, test } from "@playwright/test";

/**
 * The prefix-free i18n strategy in examples/basic: /greeting keeps one URL for
 * every locale, so the locale lives in a cookie and the switcher writes it —
 * once through an API route that redirects back (works without JavaScript),
 * once entirely on the client.
 */
test("greeting resolves the locale from Accept-Language and varies on it", async ({ request }) => {
  const response = await request.get("/greeting", { headers: { "accept-language": "nl" } });

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Eén URL, elke taal");
  // One URL for every locale: shared caches must key on the detection sources.
  expect(response.headers()["vary"]).toContain("Cookie");
  expect(response.headers()["vary"]).toContain("Accept-Language");
  // Only an explicit switch persists a locale, never detection itself.
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("greeting form switch changes the language and keeps the URL", async ({ page }) => {
  await page.goto("/greeting");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await expect(page.getByTestId("greeting-title")).toContainText("One URL, every language");

  await page.getByTestId("greeting-switch-server-nl").click();

  // The API route answers with a 303 back to this page. A hydrated <Form>
  // must land on that target, not on the API route it posted to.
  await expect(page).toHaveURL("/greeting");
  await expect(page.getByTestId("greeting-title")).toContainText("Eén URL, elke taal");

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "pracht_locale")?.value).toBe("nl");

  // The choice survives a reload, still on the same URL.
  await page.reload();
  await expect(page).toHaveURL("/greeting");
  await expect(page.getByTestId("greeting-title")).toContainText("Eén URL, elke taal");
});

test("greeting client switch swaps the dictionary without navigating", async ({ page }) => {
  await page.goto("/greeting");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.getByTestId("greeting-switch-client-nl").click();

  await expect(page.getByTestId("greeting-title")).toContainText("Eén URL, elke taal");
  await expect(page).toHaveURL("/greeting");
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "pracht_locale")?.value).toBe("nl");
  // No request to the server: only the lazily imported dictionary chunk may
  // load (a dev-mode module fetch), never a document or route-state request.
  expect(requests.filter((url) => new URL(url).pathname === "/greeting")).toHaveLength(0);
});
