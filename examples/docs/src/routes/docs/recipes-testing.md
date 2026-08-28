---
title: Testing
lead: Test your pracht app at every level — unit test loaders, API routes, middleware, and form submissions with Vitest and `@pracht/test`, run full E2E tests with Playwright to verify rendering, navigation, and hydration, and prove your agent surfaces with capability tests and `pracht eval`.
breadcrumb: Testing
prev:
  href: /docs/recipes/view-transitions
  title: View Transitions
next:
  href: /docs/recipes/logging
  title: Logging
---

## Recommended Setup

Pracht apps are built on Vite, so **Vitest** is the natural choice for unit and integration tests. For E2E browser tests, use **Playwright**. `@pracht/test` ships the first-party unit-test helpers: typed args factories, a middleware chain runner, form submission helpers, and minimal response readers.

```sh
# Install test dependencies
pnpm add -D vitest @playwright/test @pracht/test
```

---

## Unit Testing Loaders & API Routes

Loaders and API route handlers are plain async functions. `@pracht/test` builds their args objects — a complete `LoaderArgs`/`ApiRouteArgs` with a `Request`, `params`, `url` (derived from the request), `context`, `signal`, and route metadata — from a small shorthand. Every field has a sensible default; override only what the code under test reads.

### Testing a loader

```ts [src/routes/dashboard.test.ts]
import { describe, it, expect } from "vitest";
import { createLoaderArgs } from "@pracht/test";
import { loader } from "./dashboard";

describe("dashboard loader", () => {
  it("returns projects for the authenticated user", async () => {
    const data = await loader(
      createLoaderArgs({
        url: "/dashboard",
        headers: { "x-user-id": "user-1" },
      }),
    );

    expect(data.projects.length).toBeGreaterThan(0);
  });

  it("throws when no user header is present", async () => {
    await expect(loader(createLoaderArgs({ url: "/dashboard" }))).rejects.toThrow();
  });
});
```

The shorthand accepts `url` (relative paths resolve against `http://localhost`), `method`, `headers`, `body` (a plain object is JSON-encoded; `BodyInit` values pass through, with Blob/File and `URLSearchParams` normalized across JSDOM/Node realms), `params`, a partial `context`, and `route` overrides — or a fully-formed `request` that wins over all of them. The returned args also expose `controller`, the `AbortController` behind `args.signal`:

```ts
const args = createLoaderArgs({ url: "/slow" });
const pending = loader(args);
args.controller.abort();
await expect(pending).rejects.toThrow();
```

### Testing an API route

`createApiArgs()` builds the same shape for API handlers — plain or `defineApi()`-wrapped — and `readJson()` reads a response body without consuming it:

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

### Testing form submissions

`submitForm()` builds the request a form submission actually sends — `application/x-www-form-urlencoded` by default, switching to `multipart/form-data` automatically when any field is a `File` — and calls the handler with it. This exercises the same `FormData` parsing path `defineApi()` applies to real `<Form>` and native submissions. The underlying async `createFormRequest()` serializes fields to realm-neutral text/bytes, so it also works when Vitest's JSDOM environment owns `File` and `FormData` while Node owns `Request`:

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

Repeated fields (multi-selects, checkbox groups) are passed as arrays: `{ tag: ["a", "b"] }` produces two `tag` entries, which `formDataToRecord()` on the server groups back into an array. Field names and string values receive the same CRLF newline normalization as a browser form submission. A `method: "GET"` form carries no body — like a browser, the fields are serialized into the URL query string, which exercises a `defineApi()` `query` schema instead of `body`.

---

## Testing Middleware

`runMiddleware()` executes one middleware — or a chain — exactly the way the runtime does: sequentially, with `next()` callable at most once per middleware, short-circuiting when a middleware returns its own `Response`. The optional final handler stands in for the loader at the end of the chain (default: an empty 200):

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

`createMiddlewareArgs()` supplies page-route metadata. For middleware attached through `defineApp({ api: { middleware: [...] } })`, use `createApiMiddlewareArgs()` instead; its `route` matches the `ResolvedApiRoute` shape production passes.

Page and API dispatch catch a **thrown** `Response` outside the middleware chain and send it as-is, so `runMiddleware()` resolves that response by default. The raw capability middleware chain instead rejects the value and maps it to an `internal_error` envelope; use `createCapabilityTestHost()` to test that full pipeline, or opt into raw-chain behavior explicitly:

```ts
const args = createMiddlewareArgs({ url: "/dashboard" });
await expect(
  runMiddleware(auth, args, undefined, { thrownResponse: "reject" }),
).rejects.toBeInstanceOf(Response);
```

Thrown non-`Response` errors, including `notFound()`, always reject.

Chains work the same way, including `context` mutations flowing downstream — pass the middleware in the order the manifest applies them:

```ts
const args = createMiddlewareArgs<AppContext>({ url: "/admin", context: {} });
const response = await runMiddleware([logging, auth, requireAdmin], args, async () => {
  // Sees the context that auth populated, like a loader would.
  return Response.json({ user: args.context.user });
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

`createCapabilityTestHost()` runs the real dispatch pipeline in-process — no manifest, no Vite, no port. `invoke()` mirrors `invokeCapability()` and reads names plus the input/output generics preserved by the capability map supplied to that host, including test-only aliases; `request()` mirrors the generated HTTP endpoints, including agent policy, immutable simulated agent identity, and the confirmation flow. Define capabilities with a `CapabilityRunArgs<Input>` annotation (which lets the output infer) or with both `defineCapability<Input, Output>` generics — supplying only the input generic leaves the default output as `unknown`:

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

  const envelope = await page.evaluate(() => {
    const tool = (window as any).__webmcpTools.find((t: any) => t.name === "notes.search");
    return tool.execute({ query: "roadmap" });
  });

  // execute() resolves to the capability envelope as a plain value; the
  // WebMCP host serializes it itself.
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

A scenario that sets `"transport": "mcp"` runs the same steps against your app's [remote MCP endpoint](/docs/remote-mcp) instead — a real `initialize` handshake followed by one `tools/call` per step — so an `expose.mcp` capability is tested the way an MCP host would actually reach it, not through the HTTP projection standing in for it.

See [Agent Trust](/docs/agent-trust) for the scenario format, and the framework repository's `examples/basic` for a complete worked example — five capabilities with unit, E2E, and eval coverage over both transports.

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

- **Test loaders directly** — they're plain functions. `createLoaderArgs()` from `@pracht/test` builds their args; no server needed for data logic tests.
- **Test API routes directly** — they take a `Request` and return a `Response`. `createApiArgs()` and `submitForm()` build the requests without any framework setup.
- **Use E2E for hydration** — unit tests can't verify that client-side routing and hydration work correctly. That's what Playwright is for.
- Check for `(window as any).__PRACHT_ROUTER_READY__` in Playwright tests to wait for hydration before interacting with the page.
- **Test the JSON endpoint** — send `x-pracht-route-state-request: 1` to get loader data as JSON. Great for verifying data without parsing HTML.
- Keep E2E tests focused on behavior (navigation, form flows, error states) rather than visual assertions.
