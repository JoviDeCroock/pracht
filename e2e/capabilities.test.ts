import { execFile } from "node:child_process";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { acquireE2EWorkerPort, e2eUrls } from "./ports.ts";

const execFileAsync = promisify(execFile);
const capabilitiesUrl = e2eUrls.capabilities;
const capabilitiesAuthority = new URL(capabilitiesUrl).host;

// Runs against examples/basic, which registers five capabilities:
//   notes.search — read, expose.http + expose.webmcp + expose.mcp
//   notes.create — write, expose.http + expose.mcp
//   notes.purge  — destructive, expose.http (prepare/commit confirmation flow)
//   agent.whoami — read, expose.http (echoes the Web Bot Auth identity)
//   agent.ping   — read, expose.http, agentPolicy: "require"
// The app serves the remote MCP projection at /mcp (`agents.mcp`), and the dev
// server runs with PRACHT_CONFIRMATION_SECRET set (playwright.config.ts).

// ---------------------------------------------------------------------------
// HTTP projection
// ---------------------------------------------------------------------------

test("http-exposed capability answers with the ok envelope", async ({ request }) => {
  const response = await request.post("/api/capabilities/notes/search", {
    data: { query: "capabilities" },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.data.notes)).toBe(true);
  expect(body.data.notes.length).toBeGreaterThan(0);
  expect(body.data.notes[0]).toMatchObject({ title: "Capabilities" });
});

test("invalid input returns 400 with path-scoped issues", async ({ request }) => {
  const response = await request.post("/api/capabilities/notes/search", {
    data: { query: "", limit: 99 },
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("invalid_input");
  expect(body.error.issues).toEqual([
    { path: "/query", message: "must be at least 1 character(s) long" },
    { path: "/limit", message: "must be <= 20" },
  ]);
});

test("unknown capability paths return the typed 404 envelope", async ({ request }) => {
  const response = await request.post("/api/capabilities/notes/missing", { data: {} });

  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("unknown_capability");
});

test("capability endpoints reject non-POST methods", async ({ request }) => {
  const response = await request.get("/api/capabilities/notes/search");

  expect(response.status()).toBe(405);
  const body = await response.json();
  expect(body.error.code).toBe("method_not_allowed");
});

// ---------------------------------------------------------------------------
// Direct server invocation (loader) + browser invocation (callCapability)
// ---------------------------------------------------------------------------

test("loader invokes notes.search server-side and SSRs the results", async ({ request }) => {
  const response = await request.get("/notes");
  expect(response.status()).toBe(200);

  const html = await response.text();
  // Seeded notes matching the loader's query render server-side.
  expect(html).toContain("Manifest routing");
  expect(html).toContain('data-testid="notes-list"');
});

test("<Form capability> creates a note through the capability endpoint and auto-revalidates", async ({
  page,
}) => {
  await page.goto("/notes");
  await expect(page.locator('[data-testid="notes-list"] li').first()).toBeVisible();
  // Wait for hydration so the submit handler is attached before clicking.
  await expect(page.locator('[data-testid="create-note-form"]')).toHaveAttribute(
    "data-hydrated",
    "true",
  );

  await page.fill('[data-testid="create-note-form"] input[name="title"]', "A browser note");
  await page.click('[data-testid="create-note-form"] button');

  await expect(page.locator('[data-testid="create-note-status"]')).toContainText(
    'Created "A browser note"',
  );
  // Effect-driven revalidation re-runs the loader without any manual
  // revalidate() call; the new note matches the "note" query.
  await expect(page.locator('[data-testid="notes-list"]')).toContainText("A browser note");
});

test("the generated capabilities client dispatches from the browser", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/capabilities/"))
      requests.push(new URL(request.url()).pathname);
  });

  await page.goto("/notes");
  await expect(page.locator('[data-testid="create-note-form"]')).toHaveAttribute(
    "data-hydrated",
    "true",
  );

  // capabilities.notes.search(...) — the nested client, not a hand-written fetch.
  await page.click('[data-testid="search-notes-button"]');

  await expect(page.locator('[data-testid="search-notes-count"]')).toContainText("notes");
  // It reaches the same endpoint an agent calls, not some parallel route.
  expect(requests).toContain("/api/capabilities/notes/search");
});

test("useCapability tracks pending state and exposes the result", async ({ page }) => {
  await page.goto("/notes");
  await expect(page.locator('[data-testid="create-note-form"]')).toHaveAttribute(
    "data-hydrated",
    "true",
  );

  // Nothing rendered before the call: the hook dispatches on interaction, not
  // during render, so the SSR'd HTML carries no hook result.
  await expect(page.locator('[data-testid="hook-search-result"]')).toHaveCount(0);

  // Hold the response open so `pending` is observable. Asserting on it after an
  // unthrottled call would pass whether or not the flag was ever set.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/capabilities/notes/search", async (route) => {
    await held;
    await route.continue();
  });

  await page.click('[data-testid="hook-search-button"]');

  await expect(page.locator('[data-testid="hook-search-button"]')).toBeDisabled();
  await expect(page.locator('[data-testid="hook-search-button"]')).toContainText("Searching");
  await expect(page.locator('[data-testid="hook-search-result"]')).toHaveCount(0);

  release();

  await expect(page.locator('[data-testid="hook-search-result"]')).toContainText("Found");
  await expect(page.locator('[data-testid="hook-search-error"]')).toHaveCount(0);
  // Pending cleared, so the button is interactive again.
  await expect(page.locator('[data-testid="hook-search-button"]')).toBeEnabled();
});

test("<Form capability> follows endpoint redirects in the browser", async ({ page }) => {
  const endpointMethods: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/dashboard") {
      endpointMethods.push(request.method());
    }
  });

  await page.goto("/notes");
  await expect(page.locator('[data-testid="create-note-form"]')).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page
    .locator('[data-testid="create-note-form"] button')
    .evaluate((button) => button.setAttribute("formaction", "/api/dashboard?redirect=1"));
  await page.fill('[data-testid="create-note-form"] input[name="title"]', "Redirect me");
  await page.click('[data-testid="create-note-form"] button');

  await expect(page).toHaveURL("/");
  expect(endpointMethods).toEqual(["POST"]);
});

test("no-JS form posts hit the same capability contract and redirect back", async ({ request }) => {
  // The form-encoded fallback of <Form capability>: fields are coerced onto
  // the input schema and a successful document post 303s back to the page.
  const response = await request.post("/api/capabilities/notes/create", {
    form: { title: "A no-js note", body: "Posted without JavaScript." },
    headers: { accept: "text/html", referer: `${capabilitiesUrl}/notes` },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toContain("/notes");

  // Without a document accept header the JSON envelope answers as usual.
  const jsonResponse = await request.post("/api/capabilities/notes/create", {
    form: { title: "A form-encoded note", body: "Posted as urlencoded." },
  });
  expect(jsonResponse.status()).toBe(200);
  const body = await jsonResponse.json();
  expect(body.ok).toBe(true);
  expect(body.data.note.title).toBe("A form-encoded note");
});

// ---------------------------------------------------------------------------
// WebMCP projection
// ---------------------------------------------------------------------------

interface FakeRegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

test("webmcp shim registers page tools and execute() round-trips over HTTP", async ({ page }) => {
  // Fake the Chrome origin-trial API (document.modelContext.registerTool)
  // before any page script runs, so the client entry's feature detection
  // loads the shim and registers tools against it.
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as unknown as { __webmcpTools: unknown[] }).__webmcpTools = registered;
    (document as unknown as { modelContext: unknown }).modelContext = {
      registerTool(tool: unknown) {
        registered.push(tool);
        return Promise.resolve();
      },
    };
  });

  await page.goto("/notes");
  await page.waitForFunction(
    () => (window as unknown as { __webmcpTools?: unknown[] }).__webmcpTools?.length,
  );

  const tools = await page.evaluate(() =>
    (window as unknown as { __webmcpTools: FakeRegisteredTool[] }).__webmcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );

  // Only webmcp-exposed capabilities become page tools, with their real schema.
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("notes.search");
  expect(tools[0].description).toBe("Find notes whose title or body matches the query.");
  expect(tools[0].inputSchema).toMatchObject({
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
  });

  // execute() dispatches through the HTTP projection with the page's session.
  const result = await page.evaluate(async () => {
    const tool = (
      window as unknown as {
        __webmcpTools: { name: string; execute: (input: unknown) => Promise<unknown> }[];
      }
    ).__webmcpTools.find((candidate) => candidate.name === "notes.search");
    return tool!.execute({ query: "capabilities" });
  });

  const content = (result as { content: { type: string; text: string }[] }).content;
  expect(content[0].type).toBe("text");
  const envelope = JSON.parse(content[0].text);
  expect(envelope.ok).toBe(true);
  expect(envelope.data.notes[0].title).toBe("Capabilities");
});

test("zero-island responses keep the WebMCP projection executable", async ({ page }) => {
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".js")) scriptRequests.push(pathname);
  });
  await page.addInitScript(() => {
    const registered: unknown[] = [];
    (window as unknown as { __webmcpTools: unknown[] }).__webmcpTools = registered;
    (document as unknown as { modelContext: unknown }).modelContext = {
      registerTool(tool: unknown) {
        registered.push(tool);
        return Promise.resolve();
      },
    };
  });

  await page.goto("/agent-tools");
  await expect(page.getByRole("heading", { name: "Agent tools without UI islands" })).toBeVisible();
  await expect(page.locator("pracht-island")).toHaveCount(0);
  await page.waitForFunction(
    () => (window as unknown as { __webmcpTools?: unknown[] }).__webmcpTools?.length === 1,
  );
  expect(scriptRequests).toContain("/@pracht/islands.js");

  const result = await page.evaluate(async () => {
    const tool = (
      window as unknown as {
        __webmcpTools: { name: string; execute: (input: unknown) => Promise<unknown> }[];
      }
    ).__webmcpTools[0];
    return tool.execute({ query: "capabilities" });
  });
  const content = (result as { content: { text: string }[] }).content;
  expect(JSON.parse(content[0].text).data.notes[0].title).toBe("Capabilities");
});

test("without the WebMCP API the page works and registers nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto("/notes");
  await expect(page.locator('[data-testid="notes-list"] li').first()).toBeVisible();

  const hasTools = await page.evaluate(
    () => (window as unknown as { __webmcpTools?: unknown[] }).__webmcpTools !== undefined,
  );
  expect(hasTools).toBe(false);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Web Bot Auth (verified agent identity)
// ---------------------------------------------------------------------------

// The example app's manifest trusts this test agent's *public* key; the
// private part below signs requests in-test only.
const TEST_AGENT_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  d: "JZlLQqnxH-0O_1mfnuqDBB1U5XgqETE5eiRXxXRhZNM",
  x: "s5n91rPm5ymJjl--scT4WWq7HE9kUdj-6sVe5r__xgc",
};
const TEST_AGENT_KEY_ID = "9zaO23t4-sitQq-zx7KAn4Q1Ds_W1PF07ozJfoP3H70";

/**
 * Sign per draft-meunier-web-bot-auth-architecture-02: covered components
 * `@authority` + `signature-agent`, Ed25519, tag "web-bot-auth".
 */
function webBotAuthHeaders(authority: string): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const signatureAgent = '"https://test-agent.example"';
  const params =
    `("@authority" "signature-agent");created=${now};expires=${now + 300}` +
    `;keyid="${TEST_AGENT_KEY_ID}";alg="ed25519";tag="web-bot-auth"`;
  const base = [
    `"@authority": ${authority}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join("\n");

  const key = createPrivateKey({ key: TEST_AGENT_JWK, format: "jwk" });
  const signature = nodeSign(null, Buffer.from(base, "utf-8"), key);

  return {
    "signature-agent": signatureAgent,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
}

test("unsigned requests in observe mode are served with a null agent", async ({ request }) => {
  const response = await request.post("/api/capabilities/agent/whoami", { data: {} });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ ok: true, data: { verified: false } });
});

test("signed requests surface the verified agent identity", async ({ request }) => {
  const response = await request.post("/api/capabilities/agent/whoami", {
    data: {},
    headers: webBotAuthHeaders(capabilitiesAuthority),
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data).toEqual({
    verified: true,
    agentDomain: "test-agent.example",
    keyId: TEST_AGENT_KEY_ID,
  });
});

test('agentPolicy "require" rejects unsigned requests with the 401 envelope', async ({
  request,
}) => {
  const response = await request.post("/api/capabilities/agent/ping", { data: {} });
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("agent_required");
});

test('agentPolicy "require" serves verified agents', async ({ request }) => {
  const response = await request.post("/api/capabilities/agent/ping", {
    data: {},
    headers: webBotAuthHeaders(capabilitiesAuthority),
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: { pong: true } });
});

test("a bad signature does not verify", async ({ request }) => {
  const headers = webBotAuthHeaders(capabilitiesAuthority);
  // Flip the first base64 character of the signature bytes ("sig1=:" is 6 chars).
  const flipped = headers.signature[6] === "A" ? "B" : "A";
  headers.signature = headers.signature.slice(0, 6) + flipped + headers.signature.slice(7);
  const response = await request.post("/api/capabilities/agent/whoami", {
    data: {},
    headers,
  });
  const body = await response.json();
  expect(body.data).toEqual({ verified: false });
});

// ---------------------------------------------------------------------------
// Destructive capability confirmation flow (prepare/commit)
// ---------------------------------------------------------------------------

test("destructive capability requires confirmation, then commits with the token", async ({
  request,
}) => {
  // Seed a note the purge will target.
  const created = await request.post("/api/capabilities/notes/create", {
    data: { title: "E2E purge target", body: "to be deleted" },
  });
  expect((await created.json()).ok).toBe(true);

  // Prepare: no token → 409 with a confirmation token, nothing deleted.
  const prepare = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "E2E purge target" },
  });
  expect(prepare.status()).toBe(409);
  const prepareBody = await prepare.json();
  expect(prepareBody.error.code).toBe("confirmation_required");
  const token = prepareBody.error.confirmationToken as string;
  expect(typeof token).toBe("string");

  // The note still exists — prepare must not run the capability.
  const searchAfterPrepare = await request.post("/api/capabilities/notes/search", {
    data: { query: "E2E purge target" },
  });
  expect((await searchAfterPrepare.json()).data.notes.length).toBeGreaterThan(0);

  // Tampered token → 403, fail closed.
  const tampered = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "E2E purge target" },
    headers: { "x-pracht-confirm": `${token}x` },
  });
  expect(tampered.status()).toBe(403);
  expect((await tampered.json()).error.code).toBe("confirmation_invalid");

  // Different input with a valid token → 403 (token is input-bound).
  const mismatched = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "Manifest" },
    headers: { "x-pracht-confirm": token },
  });
  expect(mismatched.status()).toBe(403);

  // Commit: same input + token → runs.
  const commit = await request.post("/api/capabilities/notes/purge", {
    data: { titlePrefix: "E2E purge target" },
    headers: { "x-pracht-confirm": token },
  });
  expect(commit.status()).toBe(200);
  const commitBody = await commit.json();
  expect(commitBody.ok).toBe(true);
  expect(commitBody.data.purged).toBeGreaterThan(0);

  const searchAfterCommit = await request.post("/api/capabilities/notes/search", {
    data: { query: "E2E purge target" },
  });
  expect((await searchAfterCommit.json()).data.notes).toEqual([]);
});

// ---------------------------------------------------------------------------
// Remote MCP projection
// ---------------------------------------------------------------------------

/** One JSON-RPC round trip against the app's MCP endpoint. */
async function rpc(
  request: { post: (url: string, init: Record<string, unknown>) => Promise<any> },
  method: string,
  params?: unknown,
) {
  const response = await request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
    headers: { "content-type": "application/json" },
  });
  return { status: response.status(), body: await response.json() };
}

test("MCP initialize negotiates and reports the app's server info", async ({ request }) => {
  const { status, body } = await rpc(request, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "playwright", version: "1.0.0" },
  });

  expect(status).toBe(200);
  expect(body.result.protocolVersion).toBe("2025-06-18");
  expect(body.result.capabilities.tools).toBeDefined();
  expect(body.result.serverInfo).toEqual({ name: "pracht-basic-example", version: "0.0.0" });
});

test("MCP tools/list projects only capabilities that set expose.mcp", async ({ request }) => {
  const { body } = await rpc(request, "tools/list");
  const names = body.result.tools.map((tool: { name: string }) => tool.name).sort();

  expect(names).toEqual(["notes_create", "notes_search"]);
  // Destructive and non-mcp capabilities stay off the agent surface.
  expect(names).not.toContain("notes_purge");
  expect(names).not.toContain("agent_whoami");

  const search = body.result.tools.find((tool: { name: string }) => tool.name === "notes_search");
  expect(search.inputSchema.required).toEqual(["query"]);
  expect(search.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
});

test("MCP tools/call runs the capability and returns structured content", async ({ request }) => {
  const { body } = await rpc(request, "tools/call", {
    name: "notes_search",
    arguments: { query: "capabilities" },
  });

  expect(body.result.isError).toBe(false);
  expect(body.result.structuredContent.notes.length).toBeGreaterThan(0);
  expect(body.result.structuredContent.notes[0]).toMatchObject({ title: "Capabilities" });
});

test("MCP tools/call reports validation failures as tool errors", async ({ request }) => {
  const { body } = await rpc(request, "tools/call", {
    name: "notes_search",
    arguments: { query: "" },
  });

  expect(body.result.isError).toBe(true);
  expect(body.result.structuredContent).toBeUndefined();
  expect(body.result._meta["io.pracht/error"].code).toBe("invalid_input");
  expect(body.result._meta["io.pracht/error"].issues.length).toBeGreaterThan(0);
});

test("MCP rejects an unknown tool as a JSON-RPC error", async ({ request }) => {
  const { body } = await rpc(request, "tools/call", { name: "notes_purge", arguments: {} });

  expect(body.error.code).toBe(-32602);
  expect(body.error.message).toContain("Unknown tool");
});

test("MCP refuses GET, cross-origin, and cookie-authenticated requests", async ({ request }) => {
  const get = await request.get("/mcp");
  expect(get.status()).toBe(405);
  expect(get.headers().allow).toBe("POST");

  const crossOrigin = await request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
    headers: { "content-type": "application/json", origin: "https://evil.example" },
  });
  expect(crossOrigin.status()).toBe(403);

  const cookieAuthenticated = await request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
    headers: { "content-type": "application/json", cookie: "session=abc" },
  });
  expect(cookieAuthenticated.status()).toBe(403);
});

// ---------------------------------------------------------------------------
// pracht eval CLI
// ---------------------------------------------------------------------------

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht eval runs the example scenarios against the dev server", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliEntry, "eval", "--url", capabilitiesUrl],
    { cwd: resolve(repoRoot, "examples/basic") },
  );
  expect(stdout).toContain("PASS  notes agent flow");
  expect(stdout).toContain("confirmation_required");

  // Both halves of the agent-trust policy, which only became expressible in a
  // scenario once `signAs` shipped: a signed caller reaches a capability
  // declaring `agentPolicy: "require"`, and an unsigned one is refused.
  expect(stdout).toContain("PASS  verified agent identity");
  expect(stdout).toContain("agent_required");

  // Asserted on the failure count rather than a scenario total, so adding a
  // scenario does not break this test.
  expect(stdout).toMatch(/\d+ scenario\(s\) passed, 0 failed/);
  expect(stdout).not.toContain("FAIL");
});

test("pracht eval --start launches the app, runs the scenario, and stops it", async () => {
  const scenario = resolve(repoRoot, "e2e/fixtures/start-flow.eval.json");
  const serverScript = resolve(repoRoot, "e2e/fixtures/mini-capability-server.mjs");
  const portLease = await acquireE2EWorkerPort();
  const { port } = portLease;
  const url = `http://localhost:${port}`;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        cliEntry,
        "eval",
        scenario,
        "--start",
        `"${process.execPath}" "${serverScript}" ${port}`,
        "--url",
        url,
      ],
      { cwd: resolve(repoRoot, "examples/basic") },
    );
    expect(stdout).toContain(`Waiting for ${url}`);
    expect(stdout).toContain("PASS  start flow");
    expect(stdout).toContain("1 scenario(s) passed, 0 failed");

    // The started server must be gone once eval exits.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  } finally {
    portLease.release();
  }
});

test("pracht eval exits 1 on a failing scenario", async () => {
  const failingScenario = resolve(repoRoot, "e2e/fixtures/failing.eval.json");
  const result = await execFileAsync(
    process.execPath,
    [cliEntry, "eval", failingScenario, "--url", capabilitiesUrl, "--json"],
    { cwd: resolve(repoRoot, "examples/basic") },
  ).then(
    (value) => ({ code: 0, stdout: value.stdout }),
    (error: { code?: number; stdout?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout,
    }),
  );

  expect(result.code).toBe(1);
  const report = JSON.parse(result.stdout ?? "");
  expect(report.ok).toBe(false);
  expect(report.scenarios[0].steps[0].failures.length).toBeGreaterThan(0);
});
