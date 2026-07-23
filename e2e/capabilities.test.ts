import { execFile } from "node:child_process";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

// Runs against examples/basic (port 3103), which registers five capabilities:
//   notes.search — read, expose.http + expose.webmcp
//   notes.create — write, expose.http
//   notes.purge  — destructive, expose.http (prepare/commit confirmation flow)
//   agent.whoami — read, expose.http (echoes the Web Bot Auth identity)
//   agent.ping   — read, expose.http, agentPolicy: "require"
// The dev server runs with PRACHT_CONFIRMATION_SECRET set (playwright.config.ts).

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

test("no-JS form posts hit the same capability contract and redirect back", async ({ request }) => {
  // The form-encoded fallback of <Form capability>: fields are coerced onto
  // the input schema and a successful document post 303s back to the page.
  const response = await request.post("/api/capabilities/notes/create", {
    form: { title: "A no-js note", body: "Posted without JavaScript." },
    headers: { accept: "text/html", referer: "http://localhost:3103/notes" },
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
    headers: webBotAuthHeaders("localhost:3103"),
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
    headers: webBotAuthHeaders("localhost:3103"),
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: { pong: true } });
});

test("a bad signature does not verify", async ({ request }) => {
  const headers = webBotAuthHeaders("localhost:3103");
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
// pracht eval CLI
// ---------------------------------------------------------------------------

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht eval runs the example scenario against the dev server", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliEntry, "eval", "--url", "http://localhost:3103"],
    { cwd: resolve(repoRoot, "examples/basic") },
  );
  expect(stdout).toContain("PASS  notes agent flow");
  expect(stdout).toContain("confirmation_required");
  expect(stdout).toContain("1 scenario(s) passed, 0 failed");
});

test("pracht eval --start launches the app, runs the scenario, and stops it", async () => {
  const scenario = resolve(repoRoot, "e2e/fixtures/start-flow.eval.json");
  const serverScript = resolve(repoRoot, "e2e/fixtures/mini-capability-server.mjs");

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliEntry,
      "eval",
      scenario,
      "--start",
      `"${process.execPath}" "${serverScript}" 3177`,
      "--url",
      "http://localhost:3177",
    ],
    { cwd: resolve(repoRoot, "examples/basic") },
  );
  expect(stdout).toContain("Waiting for http://localhost:3177");
  expect(stdout).toContain("PASS  start flow");
  expect(stdout).toContain("1 scenario(s) passed, 0 failed");

  // The started server must be gone once eval exits.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  await expect(
    fetch("http://localhost:3177", { signal: AbortSignal.timeout(1_000) }),
  ).rejects.toThrow();
});

test("pracht eval exits 1 on a failing scenario", async () => {
  const failingScenario = resolve(repoRoot, "e2e/fixtures/failing.eval.json");
  const result = await execFileAsync(
    process.execPath,
    [cliEntry, "eval", failingScenario, "--url", "http://localhost:3103", "--json"],
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
