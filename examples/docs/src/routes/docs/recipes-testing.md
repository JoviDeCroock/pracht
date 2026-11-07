---
title: Testing
lead: Test loaders, API routes, and middleware with Vitest and `@pracht/test`, pages with Playwright, and agent flows with `pracht eval`.
---

This recipe sets up Vitest for loaders, API routes, and middleware, and Playwright for pages. Later sections cover capabilities, WebMCP, and agent flows.

## 1. Install

```sh
pnpm add -D vitest @playwright/test @pracht/test
```

`@pracht/test` adds typed args factories, a middleware runner, form helpers, and response readers. Keep E2E specs out of Vitest:

```ts [vitest.config.ts]
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude E2E tests (run those with Playwright)
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

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

## 2. Test a loader

Loaders are plain async functions. `createLoaderArgs()` builds their full args from a shorthand, with a default for every field:

```ts [src/routes/dashboard.test.ts]
import { describe, it, expect } from "vitest";
import { createLoaderArgs } from "@pracht/test";
import { loader } from "./dashboard";

describe("dashboard loader", () => {
  it("returns projects for the signed-in user", async () => {
    const data = await loader(
      createLoaderArgs({
        url: "/dashboard",
        context: { user: { id: "user-1" } },
      }),
    );

    expect(data.projects.length).toBeGreaterThan(0);
  });

  it("throws when no user is on the context", async () => {
    await expect(loader(createLoaderArgs({ url: "/dashboard" }))).rejects.toThrow();
  });
});
```

The shorthand accepts:

| Field | Meaning |
| --- | --- |
| `url` | Relative paths resolve against `http://localhost` |
| `method`, `headers` | Request method and headers |
| `body` | Plain objects are JSON-encoded |
| `params` | Route params |
| `context` | A partial context; provide what the code reads |
| `route` | Route metadata overrides |
| `request` | A full `Request`; wins over `url`, `method`, `headers`, and `body` |

`args.controller` aborts `args.signal`:

<!-- snippet: partial -->
```ts
const args = createLoaderArgs({ url: "/slow" });
const pending = loader(args);
args.controller.abort();
await expect(pending).rejects.toThrow();
```

## 3. Test an API route

`createApiArgs()` builds the same shape for API handlers, plain or `defineApi()`-wrapped. `readJson()` reads a response body without consuming it:

```ts [src/api/items.test.ts]
import type { ApiValidationErrorBody } from "@pracht/core";
import { describe, it, expect } from "vitest";
import { createApiArgs, readJson } from "@pracht/test";
import { GET, POST } from "./items";

describe("items API route", () => {
  it("lists items", async () => {
    const response = await GET(createApiArgs({ url: "/api/items?page=2" }));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ items: [], page: 2 });
  });

  it("creates an item from a JSON body", async () => {
    const response = await POST(
      createApiArgs({ url: "/api/items", body: { name: "Pracht" } }),
    );

    expect(await readJson(response)).toEqual({ created: "Pracht" });
  });

  it("rejects invalid input with the standardized validation body", async () => {
    const response = await POST(createApiArgs({ url: "/api/items", body: { name: "" } }));

    expect(response.status).toBe(422);
    const body = await readJson<ApiValidationErrorBody>(response);
    expect(body.issues).toEqual([{ in: "body", path: ["name"], message: "Required" }]);
  });
});
```

### Work after the response

`args.waitUntilPromises` lists the work passed to `waitUntil()`. `await args.flushWaitUntil()` waits for all of it and rejects with the first failure:

```ts [src/api/signup.test.ts]
import { expect, it } from "vitest";
import { createApiArgs } from "@pracht/test";
import { outbox } from "../server/mailer";
import { POST } from "./signup";

it("sends the welcome email after answering", async () => {
  const args = createApiArgs({ url: "/api/signup", body: { email: "ada@example.com" } });
  expect((await POST(args)).status).toBe(201);
  await args.flushWaitUntil();
  expect(outbox).toContain("ada@example.com");
});
```

### Form submissions

`submitForm()` builds the request a browser form sends (`multipart/form-data` when any field is a `File`, otherwise URL-encoded) and calls the handler with it. `createFormRequest()` returns the request without calling a handler. Both work under JSDOM.

```ts [src/api/contact.test.ts]
import { describe, it, expect } from "vitest";
import { readJson, submitForm } from "@pracht/test";
import { POST } from "./contact";

describe("contact API route", () => {
  it("succeeds with valid input", async () => {
    const response = await submitForm(POST, {
      name: "Alice",
      email: "alice@example.com",
      message: "Hello!",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ ok: true });
  });

  it("validates required fields", async () => {
    const response = await submitForm(POST, { name: "", email: "", message: "" });
    expect(response.status).toBe(422);
  });

  it("accepts an uploaded file", async () => {
    const response = await submitForm(POST, {
      name: "Alice",
      email: "alice@example.com",
      message: "See attachment",
      attachment: new File(["contents"], "notes.txt", { type: "text/plain" }),
    });
    expect(response.status).toBe(200);
  });
});
```

Pass repeated fields (multi-selects, checkbox groups) as arrays: `{ tag: ["a", "b"] }` sends two `tag` entries. With `method: "GET"`, the fields go into the query string and exercise a `defineApi()` `query` schema instead of `body`.

## 4. Test middleware

`runMiddleware()` runs one middleware, or a chain, the way the runtime does: a middleware that returns its own `Response` short-circuits the chain. The optional final handler stands in for the loader (default: an empty 200).

```ts [src/middleware/auth.test.ts]
import { describe, it, expect } from "vitest";
import { createMiddlewareArgs, readRedirect, runMiddleware } from "@pracht/test";
import { middleware as auth } from "./auth";

describe("auth middleware", () => {
  it("redirects when no session cookie is present", async () => {
    const response = await runMiddleware(auth, createMiddlewareArgs({ url: "/dashboard" }));

    expect(readRedirect(response)).toEqual({ status: 302, location: "/login" });
  });

  it("continues to the handler when the session is valid", async () => {
    const response = await runMiddleware(
      auth,
      createMiddlewareArgs({
        url: "/dashboard",
        headers: { cookie: "session=valid-token-here" },
      }),
      async () => new Response("handler ran"),
    );

    expect(await response.text()).toBe("handler ran");
  });
});
```

For middleware attached through `defineApp({ api: { middleware: [...] } })`, build args with `createApiMiddlewareArgs()` instead.

For a chain, pass the middleware in manifest order; `context` changes flow downstream:

<!-- snippet: partial -->
```ts
const args = createMiddlewareArgs<AppContext>({ url: "/admin", context: {} });
const response = await runMiddleware([logging, auth, requireAdmin], args, async () => {
  // Sees the context that auth populated, like a loader would.
  return Response.json({ user: args.context.user });
});
```

A thrown `Response` resolves as the result, because page and API dispatch send it as-is. Other thrown errors, including `notFound()`, reject. Capability dispatch maps a thrown `Response` to an `internal_error`; test that with [`createCapabilityTestHost()`](#run-the-full-pipeline-in-process), or opt into rejection:

<!-- snippet: partial -->
```ts
const args = createMiddlewareArgs({ url: "/dashboard" });
await expect(
  runMiddleware(auth, args, undefined, { thrownResponse: "reject" }),
).rejects.toBeInstanceOf(Response);
```

## 5. Test pages with Playwright

Playwright covers what unit tests cannot: hydration and client routing.

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

Check server-rendered output and status codes:

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

Before interacting, wait for `window.__PRACHT_ROUTER_READY__`, which the client router sets once it has hydrated:

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

Drive forms the way a user does:

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

Call API routes and route data over HTTP. Client navigation fetches loader data as JSON by sending `x-pracht-route-state-request: 1`:

```ts [e2e/api.test.ts]
import { test, expect } from "@playwright/test";

test("GET /api/health returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("unsupported methods return 405", async ({ request }) => {
  const response = await request.delete("/api/health");
  expect(response.status()).toBe(405);
});

test("loader returns JSON for client navigation requests", async ({ request }) => {
  const response = await request.get("/dashboard", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.projects).toBeDefined();
});
```

Keep E2E tests on behaviour (navigation, form flows, error states), not visuals.

## Test the request pipeline without a browser

`handlePrachtRequest()` runs middleware, loaders, and rendering in-process. Pass it a resolved app and a registry of mock modules:

```ts [test/integration.test.ts]
import { describe, it, expect } from "vitest";
import { defineApp, handlePrachtRequest, resolveApp, route } from "@pracht/core";

// Build a test app with mock modules
const app = resolveApp(
  defineApp({
    shells: { main: "./shells/main.tsx" },
    routes: [route("/", "./routes/home.tsx", { shell: "main", render: "ssr" })],
  }),
);

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
    const response = await handlePrachtRequest({
      request: new Request("http://localhost/"),
      app,
      registry,
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home");
  });

  it("returns loader data as JSON for client navigation", async () => {
    const response = await handlePrachtRequest({
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      app,
      registry,
    });

    const json = await response.json();
    expect(json.data.title).toBe("Home");
  });
});
```

## Test capabilities

Test [capabilities](/docs/capabilities) at three levels: `run()` for business logic, a test host for the in-process pipeline, and the HTTP projection end to end.

### Call `run()` directly

A capability module's default export carries `run()`, plus `validateInput()` and `validateOutput()`, the validators dispatch uses (schema defaults included):

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

Calling `run()` directly skips validation, middleware, and the confirmation flow.

### Run the full pipeline in-process

`createCapabilityTestHost()` runs the real dispatch pipeline without a server:

- `invoke()` mirrors `invokeCapability()`, typed from the capability map you pass the host.
- `request()` mirrors the HTTP endpoints, including agent policy, simulated agent identity, and the confirmation flow.

For typed output, annotate `run` with `CapabilityRunArgs<Input>` or pass both `defineCapability<Input, Output>` generics. Passing only `Input` leaves the output `unknown`.

```ts [src/capabilities/notes.test.ts]
import { CONFIRMATION_HEADER, createCapabilityTestHost, setCapabilityConfirmationSecret } from "@pracht/core/server";
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
    headers: { [CONFIRMATION_HEADER]: error.confirmationToken },
  });
  expect(commit.status).toBe(200);
});
```

To test `agentPolicy: "require"` and `context.agent`, inject a simulated verified identity instead of signing requests:

```ts
const response = await host.request("agent.ping", {}, {
  agent: { verified: true, agentDomain: "test-agent.example", keyId: "test-key" },
});
expect(response.status).toBe(200);
```

### Call the HTTP projection

Every exposed capability answers at `POST /api/capabilities/<name>` with a typed envelope:

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

### Destructive confirmation end to end

`destructive` capabilities need `PRACHT_CONFIRMATION_SECRET` in the server environment. Set it on Playwright's `webServer`:

<!-- snippet: partial -->
```ts [playwright.config.ts]
webServer: {
  command: "pnpm dev",
  port: 3000,
  env: { PRACHT_CONFIRMATION_SECRET: "test-only-secret" },
},
```

Then assert the prepare/commit handshake. The first call must not run the capability:

```ts [e2e/confirmation.test.ts]
import { CONFIRMATION_HEADER } from "@pracht/capabilities";

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
    headers: { [CONFIRMATION_HEADER]: error.confirmationToken },
  });
  expect(commit.status()).toBe(200);
});
```

Also assert that a tampered token, or the same token with different input, gets a `403`.

## Test WebMCP

### Verify native WebMCP in Chrome

`pracht verify` checks declarations and graph wiring without a browser. When routes expose WebMCP, add the live check:

```sh
# The browser checks drive Chrome through playwright-core.
pnpm add -D playwright-core

pracht verify webmcp --start "pracht preview"

# Pin the executable in CI; pracht never downloads an unpinned browser.
pracht verify webmcp --start "pracht preview" \
  --browser /path/to/chrome --json
```

It loads every tool-registering route in Chrome 150+, compares the registered tools with pracht's graph, and checks cleanup after navigation. Each failure (unsupported build, startup, registration, graph drift) exits non-zero with its own report `status`.

A registered tool is not necessarily safe to call. Add a WebMCP eval scenario only for inputs known to be safe:

```json [evals/notes-webmcp.eval.json]
{
  "name": "live notes page tool",
  "transport": "webmcp",
  "webmcpRoute": "/notes",
  "steps": [
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "expect": { "ok": true }
    },
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "cancelAfterMs": 0,
      "expect": { "ok": false, "status": 499, "errorCode": "cancelled" }
    }
  ]
}
```

Run it with `pracht eval`, or add its results to the verifier's JSON with `pracht verify webmcp --scenario evals/notes-webmcp.eval.json`.

### Faking WebMCP in the browser

Without a compatible Chrome, install a fake `document.modelContext` before any page script runs. The client runtime registers tools against it, and `execute()` still goes through the real HTTP projection:

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

  const envelope = await page.evaluate(() => {
    const tool = (window as any).__webmcpTools.find((t: any) => t.name === "notes.search");
    return tool.execute({ query: "roadmap" });
  });

  // execute() resolves to the capability envelope as a plain value; the
  // WebMCP host serializes it itself.
  expect(envelope.ok).toBe(true);
});
```

## Sign Web Bot Auth requests

To test the verifier itself over the wire, sign requests like a real agent: generate an Ed25519 test keypair, put the public JWK in `agents.webBotAuth.keys`, and sign with the private half.

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

## Script agent flows with `pracht eval`

`pracht eval` runs multi-step scenarios against a live server and exits `1` on any failed expectation. Scenarios live in `evals/**/*.eval.json`; `$steps[n].<path>` passes values such as confirmation tokens between steps.

```sh
# One command: start the app, wait for it, run the scenarios, stop it.
pracht eval --start "pracht preview"    # add --json for machine-readable CI output

# Or point at a server you manage yourself:
pracht eval --url http://localhost:3000
```

| `transport` | Runs the steps against |
| --- | --- |
| `"http"` (default) | The capability HTTP endpoints |
| `"mcp"` | Your app's [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser) |
| `"webmcp"` | The page tool in Chrome, with `"webmcpRoute"` set and `playwright-core` installed; a step's `cancelAfterMs` tests cancellation |

See [Agent trust](/docs/agent-trust) for the scenario format. The framework repository's `examples/basic` has unit, E2E, and eval coverage over HTTP, remote MCP, and WebMCP.
