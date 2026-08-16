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

test("locale switching rejects URL-normalized cross-origin return targets", async ({ request }) => {
  const response = await request.post("/api/locale", {
    form: { locale: "nl", next: "/\t/evil.example/phish" },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/greeting");
});

test("a prerendered locale prefix is remembered by the unprefixed detector", async ({ page }) => {
  await page.context().clearCookies();
  const response = await page.goto("/nl/welcome");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Stored SSG output must remain visitor-neutral; hydration persists the
  // explicit prefix instead.
  expect(response?.headers()["set-cookie"]).toBeUndefined();
  const html = await response?.text();
  expect(html).toContain(
    'rel="alternate" hreflang="nl" href="https://pracht-example.resynapse.dev/nl/welcome"',
  );
  await expect
    .poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.find((cookie) => cookie.name === "pracht_locale")?.value;
    })
    .toBe("nl");

  await page.goto("/welcome");
  await expect(page).toHaveURL("/nl/welcome");
});

test("greeting form switch changes the language and keeps the URL", async ({ page }) => {
  await page.goto("/greeting?from=switcher");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await expect(page.getByTestId("greeting-title")).toContainText("One URL, every language");

  await page.getByTestId("greeting-switch-server-nl").click();

  // The API route answers with a 303 back to this page. A hydrated <Form>
  // must land on that target, not on the API route it posted to.
  await expect(page).toHaveURL("/greeting?from=switcher");
  await expect(page.getByTestId("greeting-title")).toContainText("Eén URL, elke taal");

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "pracht_locale")?.value).toBe("nl");

  // The choice survives a reload, still on the same URL.
  await page.reload();
  await expect(page).toHaveURL("/greeting?from=switcher");
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
  await expect(page).toHaveTitle("Eén URL, elke taal");

  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "pracht_locale")?.value).toBe("nl");
  // No request to the server: only the lazily imported dictionary chunk may
  // load (a dev-mode module fetch), never a document or route-state request.
  expect(requests.filter((url) => new URL(url).pathname === "/greeting")).toHaveLength(0);
});

test("a server switch invalidates a pending client dictionary", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/greeting");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  let releaseDictionary!: () => void;
  const dictionaryGate = new Promise<void>((resolve) => {
    releaseDictionary = resolve;
  });
  let dictionaryRequested!: () => void;
  const sawDictionaryRequest = new Promise<void>((resolve) => {
    dictionaryRequested = resolve;
  });
  await page.route("**/src/i18n/locales/nl.ts*", async (route) => {
    dictionaryRequested();
    await dictionaryGate;
    await route.continue();
  });

  let releaseRouteState!: () => void;
  const routeStateGate = new Promise<void>((resolve) => {
    releaseRouteState = resolve;
  });
  let routeStateRequested!: () => void;
  const sawRouteStateRequest = new Promise<void>((resolve) => {
    routeStateRequested = resolve;
  });
  await page.route("**/greeting", async (route) => {
    if (route.request().headers()["x-pracht-route-state-request"] === "1") {
      routeStateRequested();
      await routeStateGate;
    }
    await route.continue();
  });

  await page.getByTestId("greeting-switch-client-nl").click();
  await sawDictionaryRequest;

  const serverSwitch = page.getByTestId("greeting-switch-server-nl");
  await serverSwitch.evaluate((button: HTMLButtonElement) => {
    // Exercise different choices with the example's two-locale registry: the
    // pending client switch chose nl, while this server switch chooses en.
    button.value = "en";
  });
  const serverSubmission = serverSwitch.click();
  await sawRouteStateRequest;

  const dictionaryResponse = page.waitForResponse("**/src/i18n/locales/nl.ts*");
  releaseDictionary();
  await dictionaryResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  const cookiesBeforeCommit = await page.context().cookies();
  expect(cookiesBeforeCommit.find((cookie) => cookie.name === "pracht_locale")?.value).toBe("en");

  releaseRouteState();
  await serverSubmission;
  await expect(page.getByTestId("greeting-title")).toContainText("One URL, every language");
});
