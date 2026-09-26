import { expect, test, type Page } from "@playwright/test";

// Request-time regions against the islands example's dev server. The region
// routes run the `visitor` middleware, which reads the `visitor` cookie into
// `context.visitor`; the Visitor region greets whoever that is.

const REGIONS_READY = 'html[data-pracht-regions-ready="true"]';

async function setVisitor(page: Page, baseURL: string | undefined, visitor: string) {
  await page.context().addCookies([{ name: "visitor", value: visitor, url: baseURL! }]);
}

test("an SSG page fills its region per visitor while the page HTML stays shared", async ({
  page,
  request,
  baseURL,
}) => {
  const anonymousHtml = await (await request.get("/regions")).text();
  const visitorHtml = await (
    await request.get("/regions", { headers: { cookie: "visitor=Ada" } })
  ).text();
  // The document is what a cache would store: identical for every visitor,
  // carrying only the fallback.
  expect(visitorHtml).toBe(anonymousHtml);
  expect(anonymousHtml).toContain("Loading visitor…");
  expect(anonymousHtml).not.toContain("Ada");

  await page.goto("/regions");
  await page.waitForSelector(REGIONS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Signed out");

  await setVisitor(page, baseURL, "Ada");
  await page.reload();
  await page.waitForSelector(REGIONS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");
  await expect(page.locator("pracht-region")).not.toHaveAttribute("pending", "");
});

test("an SSR page renders its region inline without a second request", async ({
  page,
  request,
  baseURL,
}) => {
  const html = await (
    await request.get("/regions/ssr", { headers: { cookie: "visitor=Grace" } })
  ).text();
  expect(html).toContain("Welcome back, Grace");
  expect(html).not.toContain("Loading visitor…");
  expect(html).not.toContain("/@pracht/regions.js");

  const regionRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/__pracht/region")) regionRequests.push(req.url());
  });
  await setVisitor(page, baseURL, "Grace");
  await page.goto("/regions/ssr");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Grace");
  expect(regionRequests).toEqual([]);
});

test("islands inside a region hydrate after the swap", async ({ page, baseURL }) => {
  await setVisitor(page, baseURL, "Linus");
  await page.goto("/regions/islands");
  await page.waitForSelector(REGIONS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Hello, Linus");

  const island = page.locator('pracht-island[island="/src/islands/Counter.tsx"]');
  await expect(island).toHaveAttribute("data-hydrated", "true");
  await page.getByTestId("increment").click();
  await expect(page.getByTestId("count")).toHaveText("Count: 2");
});

test("a failing region keeps its fallback and the page keeps working", async ({
  page,
  baseURL,
}) => {
  await setVisitor(page, baseURL, "broken");
  await page.goto("/regions");
  await page.waitForSelector(REGIONS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Loading visitor…");
  await expect(page.locator("h1")).toHaveText("Request-time regions");
});

test("full-hydration pages treat the region as an opaque subtree", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await setVisitor(page, baseURL, "Ada");

  await page.goto("/regions/full");
  await page.waitForSelector('html[data-pracht-hydrated="true"]');
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  // Re-rendering the page tree must leave the region's HTML untouched.
  await page.getByTestId("rerender").click();
  await expect(page.getByTestId("rerender")).toHaveText("Re-rendered 1 times");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  // A client-side navigation mounts the region fresh: it fetches its HTML.
  await page.goto("/full");
  await page.waitForSelector('html[data-pracht-hydrated="true"]');
  await page.getByRole("link", { name: "Regions" }).click();
  await expect(page.locator("h1")).toHaveText("Regions with full hydration");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  expect(errors.filter((text) => /hydration|mismatch/i.test(text))).toEqual([]);
});

test("the region endpoint is private and only answers same-origin scripts", async ({ request }) => {
  const query = new URLSearchParams({
    region: "/src/regions/Visitor.tsx",
    path: "/regions",
    props: JSON.stringify({ greeting: "Hi" }),
  });

  const response = await request.get(`/__pracht/region?${query}`, {
    headers: { "x-pracht-region": "1", cookie: "visitor=Ada" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(await response.text()).toBe(
    '<div class="visitor"><p data-testid="visitor">Hi, Ada</p></div>',
  );

  const withoutHeader = await request.get(`/__pracht/region?${query}`);
  expect(withoutHeader.status()).toBe(400);
});
