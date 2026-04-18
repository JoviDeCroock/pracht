---
name: scaffold-e2e
version: 1.0.0
description: |
  Scaffold Playwright end-to-end tests for a pracht app: install Playwright,
  generate `playwright.config.ts` that boots `pracht dev` (or `pracht
  preview`), and emit a smoke test for every route in the manifest that
  asserts 200, head/title, no console errors, and basic navigation.
  Use when asked to "scaffold E2E", "set up Playwright", "add browser tests",
  or "create smoke tests for my routes".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Scaffold E2E

Generate a Playwright suite that exercises the live app. Aligns with
`recipes-testing.md`.

## Step 1: Decide which build the tests run against

Ask the user (default: `dev`):

1. **`pracht dev`** — fast, HMR, but can mask production-only bugs (different
   bundling, different SSG/ISG flow).
2. **`pracht preview`** — preview production build; slower, closer to prod.
3. **External URL** — user provides `BASE_URL`; tests do not boot the server.

## Step 2: Install

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

Add `firefox` and `webkit` only if the user requests them.

## Step 3: Write `playwright.config.ts`

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE_URL ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "pnpm dev", // or "pnpm preview" — choose at scaffold time
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
  ],
});
```

If `playwright.config.ts` already exists, merge — do not clobber.

## Step 4: Generate per-route smoke tests

```bash
pracht inspect routes --json
```

For every route entry, generate one spec under `e2e/smoke/`. Skip routes with
dynamic segments unless the user provides example params (ask via
`AskUserQuestion`).

Per-route template:

```ts
import { test, expect } from "@playwright/test";

test.describe("smoke: <path>", () => {
  test("loads with 200 and a title", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    const response = await page.goto("<path>");
    expect(response?.status(), "HTTP status").toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);
    expect(errors, "no console errors").toEqual([]);
  });
});
```

## Step 5: Generate a navigation crawl

A single `e2e/navigation.spec.ts` that:

1. Visits the home route.
2. Collects every same-origin `<a href>`.
3. Clicks each in turn, asserts no console errors, no 4xx/5xx.

This catches client-router intercept regressions and broken links.

## Step 6: Generate a hydration check (optional)

If any route is `render: "ssr"` or `"ssg"`/`"isg"`:

```ts
test("server HTML matches client render", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("<path>");
  await page.waitForLoadState("networkidle");
  expect(errors.filter((e) => /Hydration|hydrat/i.test(e))).toEqual([]);
});
```

## Step 7: Wire `package.json`

```json
{
  "scripts": {
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui"
  }
}
```

The repo already uses `pnpm e2e` — confirm before overwriting.

## Step 8: Run

```bash
pnpm e2e
```

If specs fail on first run, report. Common first-run failures:
- Port collision (already-running dev server).
- Missing browser binary (`playwright install chromium`).
- Strict CSP blocking inline test scripts (rare).

## Rules

1. Source of routes is `pracht inspect routes --json`. Do not glob
   `src/routes/**`.
2. Skip dynamic-segment routes unless example params are provided.
3. Never overwrite an existing `playwright.config.ts` without diffing first.
4. Use `webServer` to boot `pracht dev` / `pracht preview` so CI works
   out-of-the-box.
5. Console-error capture is mandatory — silent JS errors are the most common
   pracht hydration regression.

$ARGUMENTS
