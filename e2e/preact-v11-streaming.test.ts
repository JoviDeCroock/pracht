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
