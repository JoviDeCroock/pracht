---
title: Testing
lead: Test your viact app at every level — unit test loaders and actions with Vitest, and run full E2E tests with Playwright to verify rendering, navigation, and hydration.
breadcrumb: Testing
prev:
  href: /docs/recipes/forms
  title: Forms
---

## Recommended Setup

Viact apps are built on Vite, so **Vitest** is the natural choice for unit and integration tests. For E2E browser tests, use **Playwright**.

```sh
# Install test dependencies
pnpm add -D vitest @playwright/test
```

---

## Unit Testing Loaders & Actions

Loaders and actions are plain async functions that take a `Request` and return data. Test them directly — no framework bootstrap needed.

### Testing a loader

```ts [src/routes/dashboard.test.ts]
import { describe, it, expect, vi } from "vitest";
import { loader } from "./dashboard";

describe("dashboard loader", () => {
  it("returns projects for the authenticated user", async () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { "x-user-id": "user-1" },
    });

    const data = await loader({
      request,
      params: {},
      url: new URL(request.url),
      signal: AbortSignal.timeout(5000),
    });

    expect(data.projects).toBeDefined();
    expect(data.projects.length).toBeGreaterThan(0);
  });

  it("throws 401 when no user header is present", async () => {
    const request = new Request("http://localhost/dashboard");

    await expect(
      loader({
        request,
        params: {},
        url: new URL(request.url),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow();
  });
});
```

### Testing an action

```ts [src/routes/contact.test.ts]
import { describe, it, expect } from "vitest";
import { action } from "./contact";

function makeFormRequest(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return new Request("http://localhost/contact", {
    method: "POST",
    body: form,
    headers: { origin: "http://localhost" },
  });
}

describe("contact action", () => {
  it("validates required fields", async () => {
    const result = await action({
      request: makeFormRequest({ name: "", email: "", message: "" }),
      params: {},
      url: new URL("http://localhost/contact"),
      signal: AbortSignal.timeout(5000),
    });

    expect(result.ok).toBe(false);
    expect(result.data.errors.name).toBeDefined();
    expect(result.data.errors.email).toBeDefined();
  });

  it("succeeds with valid input", async () => {
    const result = await action({
      request: makeFormRequest({
        name: "Alice",
        email: "alice@example.com",
        message: "Hello!",
      }),
      params: {},
      url: new URL("http://localhost/contact"),
      signal: AbortSignal.timeout(5000),
    });

    expect(result.ok).toBe(true);
  });
});
```

---

## Testing Middleware

Middleware functions can be tested in isolation. They either return `void` (continue) or an object with `redirect`.

```ts [src/middleware/auth.test.ts]
import { describe, it, expect } from "vitest";
import { middleware } from "./auth";

describe("auth middleware", () => {
  it("redirects when no session cookie is present", async () => {
    const request = new Request("http://localhost/dashboard");
    const result = await middleware({
      request,
      url: new URL(request.url),
      params: {},
      signal: AbortSignal.timeout(5000),
    });

    expect(result).toEqual({
      redirect: expect.stringContaining("/login"),
    });
  });

  it("continues when session is valid", async () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { cookie: "session=valid-token-here" },
    });

    const result = await middleware({
      request,
      url: new URL(request.url),
      params: {},
      signal: AbortSignal.timeout(5000),
    });

    expect(result).toBeUndefined();
  });
});
```

---

## Testing the Request Pipeline

For integration tests, use `handleViactRequest()` to test the full server pipeline — middleware, loaders, rendering — without a browser:

```ts [test/integration.test.ts]
import { describe, it, expect } from "vitest";
import { handleViactRequest, resolveApp } from "viact";

// Build a test app with mock modules
const app = resolveApp({
  shells: { main: "./shells/main.tsx" },
  middleware: {},
  routes: [
    { path: "/", file: "./routes/home.tsx", shell: "main", render: "ssr" },
  ],
});

const registry = {
  routeModules: {
    "./routes/home.tsx": async () => ({
      Component: ({ data }) => `<h1>${data.title}</h1>`,
      loader: async () => ({ title: "Home" }),
      head: ({ data }) => ({ title: data.title }),
    }),
  },
  shellModules: {
    "./shells/main.tsx": async () => ({
      Shell: ({ children }) => `<div>${children}</div>`,
    }),
  },
  middlewareModules: {},
};

describe("request pipeline", () => {
  it("renders the home page with loader data", async () => {
    const request = new Request("http://localhost/");
    const response = await handleViactRequest(request, {
      app,
      registry,
      mode: "development",
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });

  it("returns loader data as JSON for client navigation", async () => {
    const request = new Request("http://localhost/", {
      headers: { "x-viact-route-state-request": "1" },
    });
    const response = await handleViactRequest(request, {
      app,
      registry,
      mode: "development",
    });

    const json = await response.json();
    expect(json.data.title).toBe("Home");
  });
});
```

---

## E2E Testing with Playwright

E2E tests run your full app in a real browser. This is the best way to verify hydration, client navigation, and form submissions.

### Configuration

```ts [playwright.config.ts]
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  webServer: {
    command: "pnpm dev",
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
```

### Testing SSR output

```ts [e2e/ssr.test.ts]
import { test, expect } from "@playwright/test";

test("home page renders with server data", async ({ page }) => {
  await page.goto("/");

  // Check server-rendered content
  await expect(page.locator("h1")).toHaveText("Welcome");

  // Verify the page title from head()
  await expect(page).toHaveTitle(/Welcome/);
});

test("returns correct status for missing pages", async ({ request }) => {
  const response = await request.get("/nonexistent");
  expect(response.status()).toBe(404);
});
```

### Testing client-side navigation

```ts [e2e/navigation.test.ts]
import { test, expect } from "@playwright/test";

test("navigates between pages without full reload", async ({ page }) => {
  await page.goto("/");

  // Wait for hydration
  await page.waitForFunction(() => (window as any).__VIACT_ROUTER_READY__);

  // Click a link
  await page.click('a[href="/about"]');

  // URL updated
  await expect(page).toHaveURL("/about");

  // Content updated without full page reload
  await expect(page.locator("h1")).toHaveText("About");
});

test("shell persists across same-shell navigations", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__VIACT_ROUTER_READY__);

  // Mark the shell DOM to verify it's not re-mounted
  await page.evaluate(() => {
    document.querySelector(".shell")?.setAttribute("data-test", "mounted");
  });

  await page.click('a[href="/about"]');
  await expect(page).toHaveURL("/about");

  // Shell element should still have our marker
  const marker = await page.getAttribute(".shell", "data-test");
  expect(marker).toBe("mounted");
});
```

### Testing form submissions

```ts [e2e/forms.test.ts]
import { test, expect } from "@playwright/test";

test("submits contact form and shows success", async ({ page }) => {
  await page.goto("/contact");
  await page.waitForFunction(() => (window as any).__VIACT_ROUTER_READY__);

  await page.fill('input[name="name"]', "Alice");
  await page.fill('input[name="email"]', "alice@example.com");
  await page.fill('textarea[name="message"]', "Hello!");
  await page.click('button[type="submit"]');

  await expect(page.locator(".success")).toBeVisible();
});

test("shows validation errors on empty submit", async ({ page }) => {
  await page.goto("/contact");
  await page.waitForFunction(() => (window as any).__VIACT_ROUTER_READY__);

  await page.click('button[type="submit"]');

  await expect(page.locator(".field-error")).toHaveCount(3);
});
```

### Testing API routes

```ts [e2e/api.test.ts]
import { test, expect } from "@playwright/test";

test("GET /api/health returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("POST /api/echo returns the body", async ({ request }) => {
  const response = await request.post("/api/echo", {
    data: { message: "hello" },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.message).toBe("hello");
});

test("unsupported methods return 405", async ({ request }) => {
  const response = await request.delete("/api/health");
  expect(response.status()).toBe(405);
});
```

---

## Testing Route Data (JSON Endpoint)

During client navigation, viact fetches loader data as JSON. You can test this directly:

```ts
test("loader returns JSON for client navigation requests", async ({ request }) => {
  const response = await request.get("/dashboard", {
    headers: { "x-viact-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.projects).toBeDefined();
});
```

---

## Vitest Configuration

A minimal `vitest.config.ts` for a viact app:

```ts [vitest.config.ts]
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude E2E tests (run those with Playwright)
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

---

## Test Scripts

Add these to your `package.json`:

```json [package.json]
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "check": "pnpm build && pnpm typecheck && pnpm test"
  }
}
```

---

## Tips

- **Test loaders directly** — they're plain functions. No need to spin up a server for data logic tests.
- **Use E2E for hydration** — unit tests can't verify that client-side routing and hydration work correctly. That's what Playwright is for.
- Check for `(window as any).__VIACT_ROUTER_READY__` in Playwright tests to wait for hydration before interacting with the page.
- **Test the JSON endpoint** — send `x-viact-route-state-request: 1` to get loader data as JSON. Great for verifying data without parsing HTML.
- Keep E2E tests focused on behavior (navigation, form flows, error states) rather than visual assertions.
