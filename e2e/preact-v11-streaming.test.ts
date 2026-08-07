import { expect, test } from "@playwright/test";

function collectBrowserProblems(page: import("@playwright/test").Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

test("streams a Suspense fallback before content and hydrates the streamed DOM", async ({
  page,
}) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/stream?serverDelay=1000&clientDelay=1800", { waitUntil: "commit" });
  await expect(page.locator("#stream-fallback")).toBeVisible({ timeout: 500 });
  await expect(page.locator("#stream-button")).toHaveCount(0);

  await expect(page.locator("#stream-button")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#stream-fallback")).toHaveCount(0);
  await expect(page.locator("html[data-stream-boundary-hydrated]")).toHaveCount(0);

  await page.locator("#stream-button").evaluate((element) => {
    (element as HTMLElement & { __streamIdentity?: object }).__streamIdentity = {};
  });

  await expect(page.locator('html[data-stream-boundary-hydrated="true"]')).toHaveCount(1, {
    timeout: 2_000,
  });
  expect(
    await page
      .locator("#stream-button")
      .evaluate((element) =>
        Boolean((element as HTMLElement & { __streamIdentity?: object }).__streamIdentity),
      ),
  ).toBe(true);
  await expect(page.locator("#stream-button")).toHaveCount(1);
  await expect(page.locator("#stream-sibling")).toHaveCount(1);

  await page.locator("#stream-button").click();
  await expect(page.locator("#stream-button")).toHaveText("stream count: 1");
  expect(problems).toEqual([]);
});

test("parks a resolved client boundary until the server stream arrives", async ({ page }) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/stream?serverDelay=1200&clientDelay=200", { waitUntil: "commit" });
  await expect(page.locator("#stream-fallback")).toBeVisible({ timeout: 500 });
  await page.waitForTimeout(500);
  await expect(page.locator("#stream-fallback")).toBeVisible();
  await expect(page.locator("#stream-button")).toHaveCount(0);
  await expect(page.locator("html[data-stream-boundary-hydrated]")).toHaveCount(0);

  await page.waitForLoadState("load");
  await expect(page.locator('html[data-stream-boundary-hydrated="true"]')).toHaveCount(1);
  await expect(page.locator("#stream-button")).toHaveCount(1);
  await expect(page.locator("#stream-fallback")).toHaveCount(0);
  await expect(page.locator("#stream-sibling")).toHaveCount(1);

  await page.locator("#stream-button").click();
  await expect(page.locator("#stream-button")).toHaveText("stream count: 1");
  expect(problems).toEqual([]);
});

test("Hydration 2.0 resumes empty and multi-node async boundaries without shifting siblings", async ({
  page,
}) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/hydration-2?serverDelay=20&clientDelay=800");
  await expect(page.locator("#multiple-first")).toBeVisible();
  await expect(page.locator("#empty-fallback")).toHaveCount(0);
  await expect(page.locator("#multiple-fallback")).toHaveCount(0);
  await expect(page.locator("html[data-multiple-boundary-hydrated]")).toHaveCount(0);

  await page.locator("#multiple-first").evaluate((element) => {
    (element as HTMLElement & { __hydrationIdentity?: object }).__hydrationIdentity = {};
  });

  await expect(page.locator('html[data-empty-boundary-hydrated="true"]')).toHaveCount(1);
  await expect(page.locator('html[data-multiple-boundary-hydrated="true"]')).toHaveCount(1);
  expect(
    await page
      .locator("#multiple-first")
      .evaluate((element) =>
        Boolean((element as HTMLElement & { __hydrationIdentity?: object }).__hydrationIdentity),
      ),
  ).toBe(true);

  await expect(page.locator("#after-empty")).toHaveCount(1);
  await expect(page.locator("#multiple-first")).toHaveCount(1);
  await expect(page.locator("#multiple-second")).toHaveCount(1);
  await expect(page.locator("#after-multiple")).toHaveCount(1);

  await page.locator("#multiple-first").click();
  await expect(page.locator("#multiple-first")).toHaveText("multiple count: 1");
  expect(problems).toEqual([]);
});

/** Counts of every node the head/body experiment can duplicate or misplace. */
function documentShape() {
  return {
    bodyMeta: document.querySelectorAll("body meta[name=description]").length,
    bodyTitles: document.querySelectorAll("body title").length,
    headLinks: document.head.querySelectorAll("link[rel=canonical]").length,
    headMeta: document.head.querySelectorAll("meta[name=description]").length,
    headTitles: document.head.querySelectorAll("title").length,
    islands: document.querySelectorAll("preact-island").length,
    streamWrappers: document.querySelectorAll("body > div[hidden]").length,
  };
}

test("streams a head boundary into head while the body boundary streams ahead of it", async ({
  page,
}) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/head-body?headDelay=1000&bodyDelay=120&clientDelay=1200", {
    waitUntil: "commit",
  });

  // The shell flushes before either boundary resolves, so the head carries the
  // Suspense fallback title.
  await expect(page.locator("#head-body-fallback")).toBeVisible({ timeout: 500 });
  expect(await page.title()).toBe("loading title");

  // The body boundary resolves first and lands without waiting on the head.
  await expect(page.locator("#head-body-button")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#head-body-fallback")).toHaveCount(0);
  expect(await page.title()).toBe("loading title");

  // The head boundary then patches into <head>, not into the <div hidden>
  // wrapper the stream parked it in.
  await expect(async () => expect(await page.title()).toBe("resolved title")).toPass({
    timeout: 2_000,
  });

  await page.locator('head meta[name="description"]').evaluate((element) => {
    (element as HTMLElement & { __headIdentity?: object }).__headIdentity = {};
  });

  await expect(page.locator('html[data-head-boundary-hydrated="true"]')).toHaveCount(1, {
    timeout: 2_000,
  });
  await expect(page.locator('html[data-head-body-boundary-hydrated="true"]')).toHaveCount(1);

  // Hydrating the whole document reuses the streamed head nodes rather than
  // replacing them, so a late-arriving stylesheet or preload would not refetch.
  expect(
    await page
      .locator('head meta[name="description"]')
      .evaluate((element) =>
        Boolean((element as HTMLElement & { __headIdentity?: object }).__headIdentity),
      ),
  ).toBe(true);

  expect(await page.evaluate(documentShape)).toEqual({
    bodyMeta: 0,
    bodyTitles: 0,
    headLinks: 1,
    headMeta: 1,
    headTitles: 1,
    islands: 0,
    streamWrappers: 0,
  });

  await page.locator("#head-body-button").click();
  await expect(page.locator("#head-body-button")).toHaveText("head-body count: 1");
  expect(problems).toEqual([]);
});

test("streams a head boundary ahead of a still-pending body boundary", async ({ page }) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/head-body?headDelay=120&bodyDelay=1000&clientDelay=1200", {
    waitUntil: "commit",
  });

  // The head resolves while the body is still showing its fallback, so the two
  // regions stream independently in either order.
  await expect(async () => expect(await page.title()).toBe("resolved title")).toPass({
    timeout: 1_500,
  });
  await expect(page.locator("#head-body-fallback")).toBeVisible();
  await expect(page.locator("#head-body-button")).toHaveCount(0);

  await expect(page.locator("#head-body-button")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#head-body-fallback")).toHaveCount(0);

  await expect(page.locator('html[data-head-boundary-hydrated="true"]')).toHaveCount(1, {
    timeout: 2_000,
  });
  await expect(page.locator('html[data-head-body-boundary-hydrated="true"]')).toHaveCount(1);

  expect(await page.evaluate(documentShape)).toEqual({
    bodyMeta: 0,
    bodyTitles: 0,
    headLinks: 1,
    headMeta: 1,
    headTitles: 1,
    islands: 0,
    streamWrappers: 0,
  });

  await page.locator("#head-body-button").click();
  await expect(page.locator("#head-body-button")).toHaveText("head-body count: 1");
  expect(problems).toEqual([]);
});

test("leaves streamed head content unapplied when scripting is disabled", async ({
  baseURL,
  browser,
}) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto("/head-body?headDelay=200&bodyDelay=80", { waitUntil: "load" });

    // Moving a resolved boundary out of <div hidden> is the init script's job,
    // so without scripting the head keeps the fallback title and never gains
    // the description or canonical link. The resolved head markup is not just
    // missing, it is stranded in the body: the document ends up with two
    // <title> elements, and `document.title` reports the fallback because it
    // is first in tree order.
    expect(await page.title()).toBe("loading title");
    expect(await page.evaluate(documentShape)).toEqual({
      bodyMeta: 1,
      bodyTitles: 1,
      headLinks: 0,
      headMeta: 0,
      headTitles: 1,
      islands: 2,
      streamWrappers: 1,
    });

    // The body degrades too: the fallback stays and the resolved markup is
    // stranded inside the hidden wrapper.
    await expect(page.locator("#head-body-fallback")).toHaveCount(1);
    await expect(page.locator("#head-body-button")).toHaveCount(1);
    await expect(page.locator("#head-body-button")).toBeHidden();
  } finally {
    await context.close();
  }
});

// The two tests below cover the shape this experiment recommends instead:
// resolve the head in the synchronous shell and suspend only in the body.

test("renders a complete head in the shell while the body still streams", async ({ page }) => {
  const problems = collectBrowserProblems(page);

  await page.goto("/shell-head?bodyDelay=800&clientDelay=900", { waitUntil: "commit" });

  // The head is whole in the first flush — no fallback title, no dependency on
  // the patcher script — while the body is still showing its fallback.
  expect(await page.title()).toBe("shell title");
  await expect(page.locator('head meta[name="description"]')).toHaveCount(1);
  await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator("#head-body-fallback")).toBeVisible();
  await expect(page.locator("#head-body-button")).toHaveCount(0);

  // Streaming still buys everything it bought before for the body.
  await expect(page.locator("#head-body-button")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#head-body-fallback")).toHaveCount(0);

  await expect(page.locator('html[data-head-body-boundary-hydrated="true"]')).toHaveCount(1, {
    timeout: 2_000,
  });
  expect(await page.title()).toBe("shell title");

  expect(await page.evaluate(documentShape)).toEqual({
    bodyMeta: 0,
    bodyTitles: 0,
    headLinks: 1,
    headMeta: 1,
    headTitles: 1,
    islands: 0,
    streamWrappers: 0,
  });

  await page.locator("#head-body-button").click();
  await expect(page.locator("#head-body-button")).toHaveText("head-body count: 1");
  expect(problems).toEqual([]);
});

test("keeps a shell-rendered head correct when scripting is disabled", async ({
  baseURL,
  browser,
}) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto("/shell-head?bodyDelay=100", { waitUntil: "load" });

    // This is the payoff. A shell-rendered head survives with no scripting at
    // all: correct title, one title element, description and canonical in
    // place, nothing stranded in the body.
    expect(await page.title()).toBe("shell title");
    expect(await page.evaluate(documentShape)).toEqual({
      bodyMeta: 0,
      bodyTitles: 0,
      headLinks: 1,
      headMeta: 1,
      headTitles: 1,
      islands: 1,
      streamWrappers: 1,
    });

    // Only the body degrades, and it degrades to a visible fallback rather
    // than to wrong metadata.
    await expect(page.locator("#head-body-fallback")).toBeVisible();
    await expect(page.locator("#head-body-button")).toBeHidden();
  } finally {
    await context.close();
  }
});
