import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Pages are discovered and routable
// ---------------------------------------------------------------------------

test("home page renders with loader data via pages router", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  expect(response?.headers()["x-pracht-router"]).toBe("pages");

  // Shell renders
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("header")).toContainText("Pracht Pages");
  await expect(page.locator("footer")).toContainText("File-system routing");

  // Route component renders with loader data
  await expect(page.locator("h1")).toContainText("Welcome to pracht with file-system routing");
});

test("about page renders as static page", async ({ page }) => {
  await page.goto("/about");

  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("About");
  await expect(page.locator("section p").first()).toContainText("static page rendered with SSG");
});

test("@-prefixed static routes render in dev", async ({ page }) => {
  const response = await page.goto("/@alice");

  expect(response?.status()).toBe(200);
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("@alice");
});

test("underscore-prefixed directories can provide helpers without becoming routes", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".page-note")).toContainText(
    "Underscore directories can hold helpers without creating routes.",
  );

  const response = await request.get("/_components/page-note");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// _app.tsx shell wraps all pages
// ---------------------------------------------------------------------------

test("_app shell wraps all pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".pages-shell")).toBeVisible();

  await page.goto("/about");
  await expect(page.locator(".pages-shell")).toBeVisible();
});

test("a directory-scoped _app replaces the root shell for its subtree", async ({ page }) => {
  await page.goto("/blog/hello-world");
  await expect(page.locator(".blog-shell")).toBeVisible();
  await expect(page.locator(".pages-shell")).toHaveCount(0);
  await expect(page).toHaveTitle("Pracht Pages Blog");

  await page.goto("/pricing");
  await expect(page.locator(".pages-shell")).toBeVisible();
  await expect(page.locator(".blog-shell")).toHaveCount(0);
});

test("directory-scoped shells swap during client-side navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await expect(page.locator(".pages-shell")).toBeVisible();

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/blog/hello-world"]');
  await page.waitForURL("/blog/hello-world");
  await expect(page.locator(".blog-shell")).toBeVisible();
  await expect(page.locator(".pages-shell")).toHaveCount(0);

  expect(await page.evaluate(() => (window as any).__NAV_TOKEN__ === true)).toBe(true);
});

test("each page route reports its own shell in the app graph", async ({ request }) => {
  const response = await request.get("/_pracht.json");
  const graph = await response.json();
  const shells = new Map<string, string | undefined>(
    graph.routes.map((route: { path: string; shell?: string }) => [route.path, route.shell]),
  );

  expect(shells.get("/")).toBe("pages");
  expect(shells.get("/about")).toBe("pages");
  expect(shells.get("/blog/:slug")).toBe("pages:blog");
});

// ---------------------------------------------------------------------------
// Dynamic routes ([slug]) capture params
// ---------------------------------------------------------------------------

test("dynamic route captures params", async ({ page }) => {
  await page.goto("/blog/hello-world");

  await expect(page.locator(".blog-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Blog: Hello World");
  await expect(page.locator("code")).toContainText("hello-world");
});

test("dynamic route works with different slugs", async ({ page }) => {
  await page.goto("/blog/my-first-post");

  await expect(page.locator("h1")).toContainText("Blog: my first post");
  await expect(page.locator("code")).toContainText("my-first-post");
});

test("dotted dynamic routes render in dev", async ({ page }) => {
  const response = await page.goto("/blog/release-1.2.3");

  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Blog: release 1.2.3");
  await expect(page.locator("code")).toContainText("release-1.2.3");
});

test("asset-looking dynamic routes still render as pages in dev", async ({ page }) => {
  const response = await page.goto("/blog/openapi.json");

  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Blog: openapi.json");
  await expect(page.locator("code")).toContainText("openapi.json");
});

// ---------------------------------------------------------------------------
// Client-side navigation
// ---------------------------------------------------------------------------

test("client-side navigation works between pages", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to about
  await page.click('a[href="/about"]');
  await page.waitForURL("/about");

  // Token survives — no full reload
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator("h1")).toContainText("About");
});

test("client-side navigation preserves query strings and exposes search separately", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/about?tab=details"));
  await page.waitForURL("/about?tab=details");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator(".location-pathname")).toContainText("/about");
  await expect(page.locator(".location-search")).toContainText("?tab=details");
});

test("client-side navigation to dynamic route", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/blog/hello-world"]');
  await page.waitForURL("/blog/hello-world");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  await expect(page.locator("h1")).toContainText("Blog: Hello World");
});

test("typed Link, href helper, and route-object navigation work in pages-router apps", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await expect(page.locator('a[href="/blog/hello-world?ref=typed-link"]')).toContainText(
    "Read typed blog post",
  );
  await expect(page.locator('a[href="/about?tab=details"]')).toContainText("About via href()");

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/blog/hello-world?ref=typed-link"]');
  await page.waitForURL("/blog/hello-world?ref=typed-link");
  await expect(page.locator("h1")).toContainText("Blog: Hello World");

  await page.goBack();
  await page.waitForURL("/");
  await page.click("#typed-blog-button");
  await page.waitForURL("/blog/my-first-post");
  await expect(page.locator("h1")).toContainText("Blog: my first post");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// Hydration state
// ---------------------------------------------------------------------------

test("pages include hydration state", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain('id="pracht-state" type="application/json"');
  expect(html).toContain("Welcome to pracht with file-system routing");
});

test("page routes tolerate dotted query strings", async ({ request }) => {
  const response = await request.get(
    "/?shop=test-shop.myshopify.com&id_token=header.payload.signature",
  );

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");

  const html = await response.text();
  expect(html).toContain("Welcome to pracht with file-system routing");
});

// ---------------------------------------------------------------------------
// Route state JSON (client-side navigation data)
// ---------------------------------------------------------------------------

test("route state request returns JSON for pages", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()["x-pracht-router"]).toBeUndefined();
  const json = await response.json();
  expect(json.data.message).toContain("file-system routing");
});

test("route state _data requests work for dotted slugs in dev", async ({ request }) => {
  const response = await request.get("/blog/openapi.json?_data=1");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const json = await response.json();
  expect(json.data).toMatchObject({
    slug: "openapi.json",
    title: "Blog: openapi.json",
  });
});

// ---------------------------------------------------------------------------
// API routes & HOF middleware
// ---------------------------------------------------------------------------

test("GET /api/health returns JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ status: "ok" });
});

test("GET /api/me without session returns 401", async ({ request }) => {
  const response = await request.get("/api/me");
  expect(response.status()).toBe(401);

  const json = await response.json();
  expect(json).toMatchObject({ error: "Unauthorized" });
});

test("GET /api/me with session cookie returns user", async ({ request }) => {
  const response = await request.get("/api/me", {
    headers: { cookie: "session=abc123" },
  });
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ user: "Alice" });
});

// ---------------------------------------------------------------------------
// Root _middleware.ts
// ---------------------------------------------------------------------------

test("root _middleware runs on every page route", async ({ request }) => {
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  expect(home.headers()["x-pages-middleware"]).toBe("ran");

  const about = await request.get("/about");
  expect(about.status()).toBe(200);
  expect(about.headers()["x-pages-middleware"]).toBe("ran");

  const blog = await request.get("/blog/hello-world");
  expect(blog.status()).toBe(200);
  expect(blog.headers()["x-pages-middleware"]).toBe("ran");
});

test("root _middleware can redirect before the page renders", async ({ request }) => {
  const response = await request.get("/legacy", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers()["location"]).toBe("/about");
});

test("root _middleware does not wrap API routes", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-pages-middleware"]).toBeUndefined();
});

test("_middleware is not routable and appears in the app graph", async ({ request }) => {
  const notARoute = await request.get("/_middleware", { maxRedirects: 0 });
  expect(notARoute.status()).toBe(404);

  const response = await request.get("/_pracht.json");
  const graph = await response.json();
  const routePaths = graph.routes.map((route: { path: string }) => route.path);
  expect(routePaths).not.toContain("/_middleware");
  for (const route of graph.routes) {
    expect(route.middleware).toContain("pages");
  }
});

// ---------------------------------------------------------------------------
// src/capabilities/ auto-discovery and src/pages/_app.config.ts
// ---------------------------------------------------------------------------

async function mcpRpc(
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

test("an auto-discovered capability serves its HTTP projection", async ({ request }) => {
  const response = await request.post("/api/capabilities/posts/search", {
    data: { query: "pages" },
    headers: { "content-type": "application/json" },
  });

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.data.posts).toEqual([{ slug: "pages-router", title: "Pages Router" }]);
});

test("the capability appears in the app graph under its declared name", async ({ request }) => {
  const response = await request.get("/_pracht.json");
  const graph = await response.json();
  const names = (graph.capabilities ?? []).map((entry: { name: string }) => entry.name);

  expect(names).toContain("posts.search");
});

test("_app.config.ts agents.mcp serves the remote MCP projection", async ({ request }) => {
  const initialized = await mcpRpc(request, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "playwright", version: "1.0.0" },
  });

  expect(initialized.status).toBe(200);
  expect(initialized.body.result.serverInfo).toEqual({
    name: "pracht-pages-example",
    version: "0.0.0",
  });

  const listed = await mcpRpc(request, "tools/list");
  const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("posts_search");
});

test("capability modules are not routable and never reach the browser", async ({
  page,
  request,
}) => {
  expect((await request.get("/capabilities/posts-search")).status()).toBe(404);
  expect((await request.get("/_app.config")).status()).toBe(404);

  await page.goto("/");
  const html = await page.content();
  expect(html).not.toContain("Find blog posts whose title or slug matches");
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

test("unmatched route returns 404", async ({ request }) => {
  const response = await request.get("/nonexistent-page");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Dev devtools: /_pracht + Server-Timing
// ---------------------------------------------------------------------------

test("/_pracht serves the devtools page in dev", async ({ request }) => {
  const response = await request.get("/_pracht");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");

  const html = await response.text();
  expect(html).toContain("pracht");
  expect(html).toContain("/about");
  expect(html).toContain("/blog/:slug");
  expect(html).toContain("/api/health");
  expect(html).toContain("/_pracht.json");
});

test("/_pracht.json serves the resolved app graph as JSON", async ({ request }) => {
  const response = await request.get("/_pracht.json");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");

  const graph = await response.json();
  const routePaths = graph.routes.map((route: { path: string }) => route.path);
  expect(routePaths).toContain("/");
  expect(routePaths).toContain("/about");
  expect(routePaths).toContain("/blog/:slug");

  const health = graph.api.find((route: { path: string }) => route.path === "/api/health");
  expect(health.methods).toContain("GET");
  expect(health.file).toContain("health");
});

test("dev SSR responses carry a Server-Timing header with phase durations", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);

  const serverTiming = response.headers()["server-timing"];
  expect(serverTiming).toMatch(/mw;dur=\d+(\.\d+)?/);
  expect(serverTiming).toMatch(/loader;dur=\d+(\.\d+)?/);
  expect(serverTiming).toMatch(/render;dur=\d+(\.\d+)?/);
});

test("Preact 11 hydrates streamed empty and multi-element boundaries", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/streaming");
  await expect(page.locator("#streamed-message")).toHaveText("Deferred content");
  await expect(page.locator("#streamed-counter")).toBeEnabled();
  await page.locator("#streamed-counter").click();
  await expect(page.locator("#streamed-counter")).toHaveText("Count 1");
  await expect(page.locator("text=Loading empty boundary")).toHaveCount(0);
  expect(errors).toEqual([]);
});
