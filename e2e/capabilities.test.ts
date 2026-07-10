import { expect, test } from "@playwright/test";

// Runs against examples/basic (port 3103), which registers two capabilities:
//   notes.search — read, expose.http + expose.webmcp
//   notes.create — write, expose.http

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

test("browser form creates a note through callCapability and revalidates", async ({ page }) => {
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
  // revalidate() re-runs the loader; the new note matches the "note" query.
  await expect(page.locator('[data-testid="notes-list"]')).toContainText("A browser note");
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
