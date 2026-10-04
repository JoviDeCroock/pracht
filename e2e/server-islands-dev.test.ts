import { expect, test, type Page } from "@playwright/test";

// Server islands against the islands example's dev server. The server island
// routes run the `visitor` middleware, which reads the `visitor` cookie into
// `context.visitor`; the Visitor server island greets whoever that is.

const SERVER_ISLANDS_READY = 'html[data-pracht-server-islands-ready="true"]';

async function setVisitor(page: Page, baseURL: string | undefined, visitor: string) {
  await page.context().addCookies([{ name: "visitor", value: visitor, url: baseURL! }]);
}

test("an SSG page fills its server island per visitor while the page HTML stays shared", async ({
  page,
  request,
  baseURL,
}) => {
  const anonymousHtml = await (await request.get("/server-islands")).text();
  const visitorHtml = await (
    await request.get("/server-islands", { headers: { cookie: "visitor=Ada" } })
  ).text();
  // The document is what a cache would store: identical for every visitor,
  // carrying only the fallback.
  expect(visitorHtml).toBe(anonymousHtml);
  expect(anonymousHtml).toContain("Loading visitor…");
  expect(anonymousHtml).not.toContain("Ada");

  await page.goto("/server-islands");
  await page.waitForSelector(SERVER_ISLANDS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Signed out");

  await setVisitor(page, baseURL, "Ada");
  await page.reload();
  await page.waitForSelector(SERVER_ISLANDS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");
  await expect(page.locator("pracht-server-island")).not.toHaveAttribute("pending", "");
});

test("an SSR page renders its server island inline without a second request", async ({
  page,
  request,
  baseURL,
}) => {
  const html = await (
    await request.get("/server-islands/ssr", { headers: { cookie: "visitor=Grace" } })
  ).text();
  expect(html).toContain("Welcome back, Grace");
  expect(html).not.toContain("Loading visitor…");
  expect(html).not.toContain("/@pracht/server-islands.js");

  const serverIslandRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/__pracht/server-island")) serverIslandRequests.push(req.url());
  });
  await setVisitor(page, baseURL, "Grace");
  await page.goto("/server-islands/ssr");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Grace");
  expect(serverIslandRequests).toEqual([]);
});

test("islands inside a server island hydrate after the swap", async ({ page, baseURL }) => {
  await setVisitor(page, baseURL, "Linus");
  await page.goto("/server-islands/islands");
  await page.waitForSelector(SERVER_ISLANDS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Hello, Linus");

  const island = page.locator('pracht-island[island="/src/islands/Counter.tsx"]');
  await expect(island).toHaveAttribute("data-hydrated", "true");
  await page.getByTestId("increment").click();
  await expect(page.getByTestId("count")).toHaveText("Count: 2");
});

test("server islands in an island's children fill where they are shown", async ({
  page,
  baseURL,
}) => {
  const serverIslandRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname === "/__pracht/server-island") {
      serverIslandRequests.push(JSON.parse(url.searchParams.get("props") ?? "{}").greeting);
    }
  });
  await setVisitor(page, baseURL, "Ada");
  await page.goto("/server-islands/children");
  await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
  await page.waitForSelector(SERVER_ISLANDS_READY);
  const [shown, revealed] = [
    page.locator(".disclosure").nth(0),
    page.locator(".disclosure").nth(1),
  ];

  // Placed children: in the page from the start, filled like any other.
  await expect(shown.getByTestId("visitor")).toHaveText("Shown, Ada");
  // Unplaced children ship in an inert <template>: nothing is fetched for
  // them until the disclosure first shows them.
  expect(serverIslandRequests).toEqual(["Shown"]);
  await expect(revealed.locator("pracht-server-island")).toHaveCount(0);

  await revealed.getByRole("button", { name: "Closed by default" }).click();
  await expect(revealed.getByTestId("visitor")).toHaveText("Revealed, Ada");
  expect(serverIslandRequests).toEqual(["Shown", "Revealed"]);

  // Hiding and showing either again moves the filled HTML back in.
  for (const disclosure of [shown, revealed]) {
    const button = disclosure.getByRole("button");
    await button.click();
    await expect(disclosure.getByTestId("visitor")).toHaveCount(0);
    await button.click();
    await expect(disclosure.getByTestId("visitor")).toHaveText(/, Ada$/);
  }
  await page.waitForTimeout(300);
  expect(serverIslandRequests).toEqual(["Shown", "Revealed"]);
});

test("a failing server island keeps its fallback and the page keeps working", async ({
  page,
  baseURL,
}) => {
  await setVisitor(page, baseURL, "broken");
  await page.goto("/server-islands");
  await page.waitForSelector(SERVER_ISLANDS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Loading visitor…");
  await expect(page.locator("h1")).toHaveText("Server islands");
});

test("full-hydration pages treat the server island as an opaque subtree", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await setVisitor(page, baseURL, "Ada");

  await page.goto("/server-islands/full");
  await page.waitForSelector('html[data-pracht-hydrated="true"]');
  await page.waitForSelector(SERVER_ISLANDS_READY);
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  // Re-rendering the page tree must leave the server island's HTML untouched.
  await page.getByTestId("rerender").click();
  await expect(page.getByTestId("rerender")).toHaveText("Re-rendered 1 times");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  // A client-side navigation mounts the server island fresh: it fetches its HTML.
  await page.goto("/full");
  await page.waitForSelector('html[data-pracht-hydrated="true"]');
  await page.getByRole("link", { name: "Server islands" }).click();
  await expect(page.locator("h1")).toHaveText("Server islands with full hydration");
  await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

  expect(errors.filter((text) => /hydration|mismatch/i.test(text))).toEqual([]);
});

test("the server island endpoint is private and only answers same-origin scripts", async ({
  request,
}) => {
  const query = new URLSearchParams({
    island: "/src/server-islands/Visitor.tsx",
    path: "/server-islands",
    props: JSON.stringify({ greeting: "Hi" }),
  });

  const response = await request.get(`/__pracht/server-island?${query}`, {
    headers: { "x-pracht-server-island": "1", cookie: "visitor=Ada" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(await response.text()).toBe(
    '<div class="visitor"><p data-testid="visitor">Hi, Ada</p></div>',
  );

  const withoutHeader = await request.get(`/__pracht/server-island?${query}`);
  expect(withoutHeader.status()).toBe(400);
});

test("the server island endpoint refuses a server island for a page that does not list it", async ({
  request,
}) => {
  const serverIslandAt = (serverIsland: string, path: string) =>
    request.get(`/__pracht/server-island?${new URLSearchParams({ island: serverIsland, path })}`, {
      headers: { "x-pracht-server-island": "1", cookie: "visitor=Ada" },
    });

  // /static lists no server island, so the Visitor server island never runs under it —
  // and the answer is the one a server island that does not exist gets.
  const unbound = await serverIslandAt("/src/server-islands/Visitor.tsx", "/static");
  const unknown = await serverIslandAt("/src/server-islands/Nope.tsx", "/static");
  expect(unbound.status()).toBe(404);
  expect(unbound.headers()["cache-control"]).toBe("private, no-store");
  expect(await unbound.text()).toBe("Unknown server island");
  expect(await unbound.text()).toBe(await unknown.text());

  expect(
    (await serverIslandAt("/src/server-islands/Visitor.tsx", "/server-islands")).status(),
  ).toBe(200);
});
