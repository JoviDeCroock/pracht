---
title: Testing
lead: Test your pracht app at every level — unit test loaders and API routes with Vitest, run full E2E tests with Playwright to verify rendering, navigation, and hydration, and prove your agent surfaces with capability tests and <code>pracht eval</code>.
breadcrumb: Testing
prev:
  href: /docs/recipes/view-transitions
  title: View Transitions
next:
  href: /docs/recipes/logging
  title: Logging
---

## Recommended Setup

Pracht apps are built on Vite, so **Vitest** is the natural choice for unit and integration tests. For E2E browser tests, use **Playwright**.

```sh
# Install test dependencies
pnpm add -D vitest @playwright/test
```

---

## Unit Testing Loaders & API Routes

Loaders and API route handlers are plain async functions that take a `Request` and return data. Test them directly — no framework bootstrap needed.

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

### Testing an API route

```ts [src/api/contact.test.ts]
import { describe, it, expect } from "vitest";
import { POST } from "./contact";

function makeFormRequest(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return new Request("http://localhost/api/contact", {
    method: "POST",
    body: form,
  });
}

describe("contact API route", () => {
  it("validates required fields", async () => {
    const response = await POST({
      request: makeFormRequest({ name: "", email: "", message: "" }),
      params: {},
      url: new URL("http://localhost/api/contact"),
      signal: AbortSignal.timeout(5000),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.errors.name).toBeDefined();
    expect(body.errors.email).toBeDefined();
  });

  it("succeeds with valid input", async () => {
    const response = await POST({
      request: makeFormRequest({
        name: "Alice",
        email: "alice@example.com",
        message: "Hello!",
      }),
      params: {},
      url: new URL("http://localhost/api/contact"),
      signal: AbortSignal.timeout(5000),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
```

---

## Testing Middleware

Middleware always returns a `Response`. To test it in isolation, pass a fake
`next` that resolves to a sentinel response — then assert on whether the
middleware short-circuited (returned its own response) or called through
(returned the sentinel).

```ts [src/middleware/auth.test.ts]
import { describe, it, expect } from "vitest";
import { middleware } from "./auth";

describe("auth middleware", () => {
  const ok = new Response("ok", { status: 200 });
  const next = async () => ok;

  it("redirects when no session cookie is present", async () => {
    const request = new Request("http://localhost/dashboard");
    const response = await middleware(
      {
        request,
        url: new URL(request.url),
        params: {},
        context: {},
        signal: AbortSignal.timeout(5000),
        route: { path: "/dashboard" } as any,
      },
      next,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/\/login/);
  });

  it("continues to the handler when session is valid", async () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { cookie: "session=valid-token-here" },
    });

    const response = await middleware(
      {
        request,
        url: new URL(request.url),
        params: {},
        context: {},
        signal: AbortSignal.timeout(5000),
        route: { path: "/dashboard" } as any,
      },
      next,
    );

    expect(response).toBe(ok);
  });
});
```

---

## Testing the Request Pipeline

For integration tests, use `handlePrachtRequest()` to test the full server pipeline — middleware, loaders, rendering — without a browser:

```ts [test/integration.test.ts]
import { describe, it, expect } from "vitest";
import { handlePrachtRequest, resolveApp } from "@pracht/core";

// Build a test app with mock modules
const app = resolveApp({
  shells: { main: "./shells/main.tsx" },
  middleware: {},
  routes: [{ path: "/", file: "./routes/home.tsx", shell: "main", render: "ssr" }],
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
    const response = await handlePrachtRequest(request, {
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
      headers: { "x-pracht-route-state-request": "1" },
    });
    const response = await handlePrachtRequest(request, {
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
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Click a link
  await page.click('a[href="/about"]');

  // URL updated
  await expect(page).toHaveURL("/about");

  // Content updated without full page reload
  await expect(page.locator("h1")).toHaveText("About");
});

test("shell persists across same-shell navigations", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

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
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.fill('input[name="name"]', "Alice");
  await page.fill('input[name="email"]', "alice@example.com");
  await page.fill('textarea[name="message"]', "Hello!");
  await page.click('button[type="submit"]');

  await expect(page.locator(".success")).toBeVisible();
});

test("shows validation errors on empty submit", async ({ page }) => {
  await page.goto("/contact");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

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

During client navigation, pracht fetches loader data as JSON. You can test this directly:

```ts
test("loader returns JSON for client navigation requests", async ({ request }) => {
  const response = await request.get("/dashboard", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.projects).toBeDefined();
});
```

---

## Testing Capabilities & Agent Surfaces

[Capabilities](/docs/capabilities) are testable at three levels: unit test the `run()` function, E2E test the HTTP projection, and script whole agent flows with [`pracht eval`](/docs/agent-trust).

### Unit testing run()

A capability module's default export carries its `run()` function — call it directly to test the business logic:

```ts [src/capabilities/notes-search.test.ts]
import { describe, it, expect } from "vitest";
import notesSearch from "./notes-search";

describe("notes.search", () => {
  it("finds notes matching the query", async () => {
    const result = await notesSearch.run({
      input: { query: "roadmap", limit: 10 },
      context: {},
      request: new Request("http://localhost/api/capabilities/notes/search"),
      signal: AbortSignal.timeout(5000),
    });

    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("rejects out-of-range input", () => {
    const result = notesSearch.validateInput({ query: "roadmap", limit: 99 });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: "/limit", message: "must be <= 20" }],
    });
  });
});
```

The object `defineCapability()` returns also carries `validateInput()` / `validateOutput()` — the exact validators the dispatch pipeline uses, including schema defaults — so contract behavior is unit-testable without a server.

Note the boundary: calling `run()` directly skips validation, the middleware chain, and the confirmation flow. For those, build a test host.

### The full pipeline without a server

`createCapabilityTestHost()` runs the real dispatch pipeline in-process — no manifest, no Vite, no port. `invoke()` mirrors `invokeCapability()`; `request()` mirrors the generated HTTP endpoints, including agent policy and the confirmation flow:

```ts [src/capabilities/notes.test.ts]
import { createCapabilityTestHost, setCapabilityConfirmationSecret } from "@pracht/core";
import notesSearch from "./notes-search";
import notesPurge from "./notes-purge";

const host = createCapabilityTestHost({
  capabilities: { "notes.search": notesSearch, "notes.purge": notesPurge },
  middleware: { auth: authMiddleware }, // for capabilities declaring middleware: ["auth"]
});

it("runs validation, middleware, run(), and output validation", async () => {
  const result = await host.invoke("notes.search", { query: "roadmap" });
  expect(result.ok).toBe(true);
});

it("walks the prepare/commit confirmation flow", async () => {
  setCapabilityConfirmationSecret("test-only-secret");

  const prepare = await host.request("notes.purge", { titlePrefix: "Old" });
  expect(prepare.status).toBe(409);
  const { error } = await prepare.json();

  const commit = await host.request("notes.purge", { titlePrefix: "Old" }, {
    headers: { "x-pracht-confirm": error.confirmationToken },
  });
  expect(commit.status).toBe(200);
});
```

To test `agentPolicy: "require"` and `context.agent`, inject a simulated verified identity — no request signing needed:

```ts
const response = await host.request("agent.ping", {}, {
  agent: { verified: true, agentDomain: "test-agent.example", keyId: "test-key" },
});
expect(response.status).toBe(200);
```

### E2E testing the HTTP projection

Every exposed capability answers at `POST /api/capabilities/<name>` with a typed envelope, which makes Playwright request tests precise:

```ts [e2e/capabilities.test.ts]
import { test, expect } from "@playwright/test";

test("capability answers with the ok envelope", async ({ request }) => {
  const response = await request.post("/api/capabilities/notes/search", {
    data: { query: "roadmap" },
  });

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.data.notes)).toBe(true);
});

test("invalid input returns path-scoped issues", async ({ request }) => {
  const response = await request.post("/api/capabilities/notes/search", {
    data: { query: "", limit: 99 },
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe("invalid_input");
  expect(body.error.issues).toEqual([
    { path: "/query", message: "must be at least 1 character(s) long" },
    { path: "/limit", message: "must be <= 20" },
  ]);
});
```

### Testing the destructive confirmation flow

`destructive` capabilities need `PRACHT_CONFIRMATION_SECRET` in the server environment — set it on Playwright's `webServer` so the flow works in CI:

```ts [playwright.config.ts]
webServer: {
  command: "pnpm dev",
  port: 3000,
  env: { PRACHT_CONFIRMATION_SECRET: "test-only-secret" },
},
```

Then assert the prepare/commit handshake — the first call must not run the capability:

```ts [e2e/confirmation.test.ts]
test("destructive capability requires confirmation, then commits", async ({ request }) => {
  // Prepare: no token → 409 with a confirmation token, nothing deleted.
  const prepare = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "Old" },
  });
  expect(prepare.status()).toBe(409);
  const { error } = await prepare.json();
  expect(error.code).toBe("confirmation_required");

  // Commit: identical input + the token → runs.
  const commit = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "Old" },
    headers: { "x-pracht-confirm": error.confirmationToken },
  });
  expect(commit.status()).toBe(200);
});
```

Worth asserting too: a tampered token and a same-token-different-input call both answer `403`.

### Faking WebMCP in the browser

No agent is needed to test the [WebMCP projection](/docs/capabilities). Install a fake `document.modelContext` before any page script runs — the client runtime's feature detection will register tools against it, and `execute()` round-trips through the real HTTP projection:

```ts [e2e/webmcp.test.ts]
test("webmcp tools register and execute", async ({ page }) => {
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as any).__webmcpTools = registered;
    (document as any).modelContext = {
      registerTool: (tool: unknown) => (registered.push(tool), Promise.resolve()),
    };
  });

  await page.goto("/notes");
  await page.waitForFunction(() => (window as any).__webmcpTools?.length);

  const result = await page.evaluate(() => {
    const tool = (window as any).__webmcpTools.find((t: any) => t.name === "notes.search");
    return tool.execute({ query: "roadmap" });
  });

  const envelope = JSON.parse(result.content[0].text);
  expect(envelope.ok).toBe(true);
});
```

### Signing Web Bot Auth requests in tests

The test host's `agent` option covers pipeline behavior; to test the *verifier itself* over the wire, sign requests the way a real agent would. Generate an Ed25519 test keypair, put the *public* JWK in your manifest's `agents.webBotAuth.keys`, and sign with the private part in tests:

```ts [e2e/web-bot-auth.ts]
import { createPrivateKey, sign } from "node:crypto";

// Test-only keypair; the public `x` half lives in defineApp({ agents }).
const TEST_AGENT_JWK = { kty: "OKP", crv: "Ed25519", d: "<private>", x: "<public>" };
const KEY_ID = "<RFC 7638 JWK thumbprint of the public key>";

export function webBotAuthHeaders(authority: string): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const signatureAgent = '"https://test-agent.example"';
  const params =
    `("@authority" "signature-agent");created=${now};expires=${now + 300}` +
    `;keyid="${KEY_ID}";alg="ed25519";tag="web-bot-auth"`;
  const base = [
    `"@authority": ${authority}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join("\n");

  const key = createPrivateKey({ key: TEST_AGENT_JWK, format: "jwk" });
  const signature = sign(null, Buffer.from(base, "utf-8"), key);

  return {
    "signature-agent": signatureAgent,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
}
```

```ts [e2e/agent-identity.test.ts]
test("verified agents pass agentPolicy: require", async ({ request }) => {
  const response = await request.post("/api/capabilities/agent/ping", {
    data: {},
    headers: webBotAuthHeaders("localhost:3000"),
  });
  expect(response.status()).toBe(200);
});

test("unsigned requests are rejected", async ({ request }) => {
  const response = await request.post("/api/capabilities/agent/ping", { data: {} });
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("agent_required");
});
```

### Scripted agent flows with pracht eval

`pracht eval` runs multi-step scenarios against a live server and exits `1` on any failed expectation — regression tests for your agent UX. Scenarios live in `evals/**/*.eval.json`; `$steps[n].<path>` references thread values (like confirmation tokens) between steps:

```sh
# One command: start the app, wait for it, run the scenarios, stop it.
pracht eval --start "pracht preview"    # add --json for machine-readable CI output

# Or point at a server you manage yourself:
pracht eval --url http://localhost:3000
```

See [Agent Trust](/docs/agent-trust) for the scenario format, and the framework repository's `examples/basic` for a complete worked example — five capabilities with unit, E2E, and eval coverage.

---

## Vitest Configuration

A minimal `vitest.config.ts` for a pracht app:

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
- **Test API routes directly** — they take a `Request` and return a `Response`. Easy to unit test without any framework setup.
- **Use E2E for hydration** — unit tests can't verify that client-side routing and hydration work correctly. That's what Playwright is for.
- Check for `(window as any).__PRACHT_ROUTER_READY__` in Playwright tests to wait for hydration before interacting with the page.
- **Test the JSON endpoint** — send `x-pracht-route-state-request: 1` to get loader data as JSON. Great for verifying data without parsing HTML.
- Keep E2E tests focused on behavior (navigation, form flows, error states) rather than visual assertions.
