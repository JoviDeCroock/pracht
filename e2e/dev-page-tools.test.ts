import { expect, test } from "@playwright/test";

/**
 * Dev-only WebMCP page tools: every document `pracht dev` serves registers
 * `pracht_*` tools with the browser's model context so an agent driving the
 * tab can ask it what it is showing. Runs against examples/basic.
 */

interface RegisteredTool {
  name: string;
  description: string;
  annotations?: Record<string, unknown>;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

/** Test-only globals; cast per use so the framework's own `Window` augmentation stays untouched. */
type ToolsWindow = {
  __activeTools: Map<string, RegisteredTool>;
  __PRACHT_NAVIGATE__: (href: string) => Promise<void>;
  __PRACHT_ROUTER_READY__?: boolean;
};

async function installFakeModelContext(page: import("@playwright/test").Page): Promise<void> {
  // Fake the WebMCP API (document.modelContext.registerTool) before any page
  // script runs; abort on the registration signal removes the tool, matching
  // the draft spec the runtime targets.
  await page.addInitScript(() => {
    const active = new Map<string, RegisteredTool>();
    (window as unknown as ToolsWindow).__activeTools = active;
    (document as unknown as { modelContext: unknown }).modelContext = {
      registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
        active.set(tool.name, tool);
        options?.signal?.addEventListener(
          "abort",
          () => {
            if (active.get(tool.name) === tool) active.delete(tool.name);
          },
          { once: true },
        );
        return Promise.resolve();
      },
    };
  });
}

async function waitForDevTools(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() =>
    (window as unknown as ToolsWindow).__activeTools.has("pracht_route"),
  );
}

async function call(
  page: import("@playwright/test").Page,
  name: string,
  input: unknown = {},
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; error: Record<string, unknown> }
> {
  return page.evaluate(
    ([toolName, toolInput]) =>
      (window as unknown as ToolsWindow).__activeTools.get(toolName)!.execute(toolInput, {}),
    [name, input] as [string, unknown],
  ) as never;
}

test("every dev document registers the read-only pracht_* tools", async ({ page }) => {
  await installFakeModelContext(page);
  await page.goto("/notes");
  await waitForDevTools(page);

  const tools = await page.evaluate(() =>
    [...(window as unknown as ToolsWindow).__activeTools.values()]
      .filter((tool) => tool.name.startsWith("pracht_"))
      .map((tool) => ({ name: tool.name, annotations: tool.annotations }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  expect(tools).toEqual([
    { name: "pracht_islands", annotations: { readOnlyHint: true } },
    { name: "pracht_last_error", annotations: { readOnlyHint: true } },
    { name: "pracht_loader_data", annotations: { readOnlyHint: true } },
    { name: "pracht_page_tools", annotations: { readOnlyHint: true } },
    { name: "pracht_route", annotations: { readOnlyHint: true } },
  ]);
});

test("pracht_route and pracht_loader_data describe the rendered route", async ({ page }) => {
  await installFakeModelContext(page);
  await page.goto("/notes");
  await waitForDevTools(page);

  const route = await call(page, "pracht_route");
  expect(route).toMatchObject({
    ok: true,
    data: {
      url: "/notes",
      routeId: "notes",
      params: {},
      matched: {
        id: "notes",
        path: "/notes",
        file: "./routes/notes.tsx",
        render: "ssr",
        hydration: "full",
        shell: "public",
        capabilities: ["notes.search"],
        notFound: false,
      },
    },
  });

  const data = await call(page, "pracht_loader_data", { path: "notes.0.title" });
  expect(data).toMatchObject({
    ok: true,
    data: { routeId: "notes", path: "notes.0.title", data: "Manifest routing" },
  });

  const missing = await call(page, "pracht_loader_data", { path: "notes.99.title" });
  expect(missing).toMatchObject({ ok: false, error: { code: "path_not_found" } });
});

test("pracht_page_tools lists the app's own WebMCP tools on the route", async ({ page }) => {
  await installFakeModelContext(page);
  await page.goto("/notes");
  await waitForDevTools(page);

  const result = await call(page, "pracht_page_tools");
  expect(result).toMatchObject({
    ok: true,
    data: {
      routeId: "notes",
      active: [
        {
          name: "notes.search",
          title: "Search notes",
          effect: "read",
          httpPath: "/api/capabilities/notes/search",
        },
      ],
      inactive: [],
      mcpEndpoint: "/mcp",
    },
  });
});

test("the tools follow committed client-side navigation", async ({ page }) => {
  await installFakeModelContext(page);
  await page.goto("/notes");
  await waitForDevTools(page);
  await page.waitForFunction(() => (window as unknown as ToolsWindow).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => (window as unknown as ToolsWindow).__PRACHT_NAVIGATE__("/"));
  await expect
    .poll(async () => {
      const result = await call(page, "pracht_route");
      return result.ok ? (result.data as { routeId: string }).routeId : null;
    })
    .toBe("home");

  const route = await call(page, "pracht_route");
  expect(route).toMatchObject({
    ok: true,
    data: { url: "/", routeId: "home", source: "runtime", clientRouter: true },
  });
  const data = await call(page, "pracht_loader_data", { path: "highlights.0" });
  expect(data).toMatchObject({
    ok: true,
    data: { source: "runtime", data: "Hybrid route manifest" },
  });
});

test("islands routes report their islands and explain the missing loader data", async ({
  page,
}) => {
  await installFakeModelContext(page);
  await page.goto("/agent-tools");
  await waitForDevTools(page);

  const islands = await call(page, "pracht_islands");
  expect(islands).toMatchObject({
    ok: true,
    data: { routeId: "agent-tools", hydration: "islands", islands: [] },
  });

  const data = await call(page, "pracht_loader_data");
  expect(data).toMatchObject({
    ok: false,
    error: {
      code: "no_route_state",
      message: expect.stringContaining('hydration: "islands"'),
    },
  });
});

test("pracht_last_error records uncaught client errors newest first", async ({ page }) => {
  await installFakeModelContext(page);
  await page.goto("/notes");
  await waitForDevTools(page);

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("e2e client boom");
    }, 0);
  });
  await page.evaluate(() => {
    void Promise.reject(new Error("e2e unhandled rejection"));
  });

  await expect
    .poll(async () => {
      const result = await call(page, "pracht_last_error");
      return result.ok ? (result.data.client as { message: string }[]).map((e) => e.message) : [];
    })
    .toEqual(["e2e unhandled rejection", "e2e client boom"]);
  const result = await call(page, "pracht_last_error");
  expect(result).toMatchObject({ ok: true, data: { server: null } });
});

test("the not-found page identifies itself", async ({ page }) => {
  await installFakeModelContext(page);
  const response = await page.goto("/this-route-does-not-exist");
  expect(response?.status()).toBe(404);
  await waitForDevTools(page);

  const route = await call(page, "pracht_route");
  expect(route).toMatchObject({
    ok: true,
    data: {
      url: "/this-route-does-not-exist",
      matched: { file: "./routes/not-found.tsx", notFound: true },
    },
  });
});

test("without the WebMCP API nothing is registered and no runtime is loaded", async ({ page }) => {
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) scriptRequests.push(pathname);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto("/notes");
  await expect(page.locator('[data-testid="notes-list"] li').first()).toBeVisible();

  // The tiny generated module loads (it is the feature check), the runtime
  // behind it does not.
  expect(scriptRequests).toContain("/@pracht/dev-page-tools.js");
  expect(scriptRequests.some((path) => path.includes("dev-page-tools.mjs"))).toBe(false);
  expect(errors).toEqual([]);
});
