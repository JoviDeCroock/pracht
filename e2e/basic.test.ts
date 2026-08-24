import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// SSR: Home page (render: "ssg" — served via SSR in dev)
// ---------------------------------------------------------------------------

test("home page renders SSR HTML with loader data", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");

  // Shell renders
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("header")).toContainText("Pracht");
  await expect(page.locator("footer")).toContainText("Preact-first");

  // Route component renders with loader data
  await expect(page.locator("h1")).toContainText("explicit app manifest");
  await expect(page.locator("li").first()).toContainText("Hybrid route manifest");
});

test("home page HTML includes hydration state", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain('id="pracht-state" type="application/json"');
  expect(html).toContain('"routeId":"home"');
  expect(html).toContain("Hybrid route manifest");
});

test("home page HTML includes shell CSS before the client entry", async ({ request }) => {
  const response = await request.get("/", { headers: { accept: "text/html" } });
  const html = await response.text();

  const stylesheet = '<link rel="stylesheet" href="/src/styles/global.css">';
  expect(html).toContain(stylesheet);
  expect(html.indexOf(stylesheet)).toBeLessThan(html.indexOf('src="/@pracht/client.js"'));
});

test("home page includes default security headers", async ({ request }) => {
  const response = await request.get("/");

  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("home page has correct head metadata", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(html).toContain("<title>Pracht Example</title>");
  expect(html).toContain('name="viewport"');
});

test("home page emits a speculationrules script with opted-in routes", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  const match = html.match(/<script type="speculationrules">([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();

  const decoded = (match?.[1] ?? "")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u0026/g, "&");
  type Rule = {
    where: { and: [{ href_matches: string[] }, { not: { selector_matches: string[] } }] };
    eagerness: string;
  };
  const rules = JSON.parse(decoded) as { prefetch?: Rule[]; prerender?: Rule[] };

  const prefetchHrefs = rules.prefetch?.flatMap((r) => r.where.and[0].href_matches) ?? [];
  expect(prefetchHrefs).toEqual(expect.arrayContaining(["/", "/pricing", "/products/:id"]));
  expect(rules.prefetch?.[0].eagerness).toBe("moderate");
  // Anchor-level exclusions ride along on every rule.
  expect(rules.prefetch?.[0].where.and[1].not.selector_matches).toEqual(
    expect.arrayContaining(['a[rel~="nofollow"]', 'a[data-pracht-speculate="off"]']),
  );
});

test("chromium accepts the speculation rules and their exclusion selectors", async ({ page }) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  await page.goto("/");

  const selectors = await page.evaluate(() => {
    const script = document.querySelector('script[type="speculationrules"]');
    if (!script?.textContent) return null;
    const rules = JSON.parse(script.textContent) as {
      prefetch?: Array<{ where: { and: [unknown, { not: { selector_matches: string[] } }] } }>;
    };
    return rules.prefetch?.[0].where.and[1].not.selector_matches ?? null;
  });
  expect(selectors).not.toBeNull();

  // Chrome parses the rule set at load; a malformed clause or selector shows up
  // as a console error naming speculation rules.
  expect(messages.filter((text) => /speculation/i.test(text))).toEqual([]);

  // The fail-closed scope semantics, evaluated by a real CSS engine.
  const verdicts = await page.evaluate((list: string[]) => {
    const selector = list.join(",");
    const host = document.createElement("div");
    host.innerHTML = `
      <a id="plain" href="/pricing"></a>
      <a id="nofollow" href="/pricing" rel="nofollow"></a>
      <a id="self-off" href="/pricing" data-pracht-speculate="off"></a>
      <nav data-pracht-speculate="off">
        <a id="scoped-off" href="/pricing"></a>
        <a id="scoped-on" href="/pricing" data-pracht-speculate="on"></a>
        <div data-pracht-speculate="on"><a id="nested-on" href="/pricing"></a></div>
        <div data-pracht-speculate="on">
          <div data-pracht-speculate="off"><a id="alternating-off" href="/pricing"></a></div>
        </div>
      </nav>
      <nav data-pracht-speculate="on">
        <div data-pracht-speculate="off"><a id="nested-off" href="/pricing"></a></div>
      </nav>`;
    document.body.appendChild(host);
    const read = (id: string) => document.getElementById(id)!.matches(selector);
    const result = {
      plain: read("plain"),
      nofollow: read("nofollow"),
      selfOff: read("self-off"),
      scopedOff: read("scoped-off"),
      scopedOn: read("scoped-on"),
      nestedOn: read("nested-on"),
      nestedOff: read("nested-off"),
      alternatingOff: read("alternating-off"),
    };
    host.remove();
    return result;
  }, selectors as string[]);

  expect(verdicts).toEqual({
    plain: false,
    nofollow: true,
    selfOff: true,
    scopedOff: true,
    scopedOn: false,
    nestedOn: true,
    nestedOff: true,
    alternatingOff: true,
  });
});

test("chrome speculates included links and skips excluded ones", async ({ page }) => {
  const speculated: string[] = [];
  page.on("request", (request) => {
    if (request.headers()["sec-purpose"]) speculated.push(new URL(request.url()).search);
  });
  await page.goto("/");

  // Document rules match the live DOM, so anchors added after load count too.
  await page.evaluate(() => {
    const host = document.createElement("div");
    // Distinct query strings so each hover maps to its own prefetch entry.
    host.innerHTML = `
      <a id="spec-included" href="/pricing?spec=included">included</a>
      <a id="spec-off" href="/pricing?spec=off" data-pracht-speculate="off">off</a>
      <a id="spec-nofollow" href="/pricing?spec=nofollow" rel="nofollow">nofollow</a>`;
    document.body.appendChild(host);
  });

  // `prefetch` speculation defaults to `moderate` eagerness — hover triggers it.
  const prefetched = page.waitForRequest(
    (request) => request.url().includes("spec=included") && !!request.headers()["sec-purpose"],
  );
  await page.locator("#spec-included").hover();
  await prefetched;

  await page.locator("#spec-off").hover();
  await page.locator("#spec-nofollow").hover();
  await page.waitForTimeout(1500);

  expect(speculated).toEqual(["?spec=included"]);
});

// ---------------------------------------------------------------------------
// SSR: Pricing page (render: "isg" — served via SSR in dev)
// ---------------------------------------------------------------------------

test("pricing page renders with loader data", async ({ page }) => {
  await page.goto("/pricing");

  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("MVP plan");
  await expect(page.locator("section")).toContainText("ISG fits pricing pages");
});

// ---------------------------------------------------------------------------
// Middleware: auth redirect
// ---------------------------------------------------------------------------

test("dashboard redirects to / without session cookie", async ({ page }) => {
  const response = await page.goto("/dashboard");

  // Middleware should redirect unauthenticated users to /
  expect(page.url()).toContain("/");
  expect(response?.status()).toBe(200);
});

test("hydration marks the document with data-pracht-hydrated", async ({ page }) => {
  await page.goto("/");
  await page.locator("html[data-pracht-hydrated]").waitFor();

  const marker = await page.getAttribute("html", "data-pracht-hydrated");
  expect(marker).toBe("true");
});

test("client navigation to a protected route no-ops when middleware redirects back to the current page", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
    const link = document.createElement("a");
    link.href = "/dashboard";
    link.id = "protected-dashboard-link";
    link.textContent = "Dashboard";
    document.body.appendChild(link);
  });

  await page.click("#protected-dashboard-link", { timeout: 1_000 });

  await expect(page).toHaveURL("/");
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("client redirects preserve hash fragments instead of swallowing them as current-page no-ops", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (input === "/dashboard") {
        return new Response(JSON.stringify({ redirect: "/#install" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      return originalFetch(input, init);
    };

    const link = document.createElement("a");
    link.href = "/dashboard";
    link.id = "hash-redirect-link";
    link.textContent = "Dashboard";
    document.body.appendChild(link);
  });

  await page.click("#hash-redirect-link", { timeout: 1_000 });

  await expect(page).toHaveURL(/\/#install$/);
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("dashboard renders with session cookie", async ({ page, context }) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Ada Lovelace");
  await expect(page.locator("p")).toContainText("Projects: 3");
});

test("dashboard form posts to API route and keeps the current route hydrated", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__ACTION_TOKEN__ = true;
  });

  await page.click('button[type="submit"]');

  await expect(page).toHaveURL("/dashboard");
  await expect(page.locator("h1")).toContainText("Ada Lovelace");
  await expect(page.locator("p")).toContainText("Projects: 3");

  const tokenSurvived = await page.evaluate(() => (window as any).__ACTION_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// SPA route: Settings
// ---------------------------------------------------------------------------

test("settings returns SPA shell chrome and loading UI without SSR route content", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  const response = await page.goto("/settings");
  expect(response?.status()).toBe(200);

  const html = await response?.text();
  expect(html).toContain("Loading page...");
  expect(html).toContain("Back to home");
  expect(html).not.toContain("<h1>Settings</h1>");
});

test("settings hydrates correctly on a direct authenticated load", async ({ page, context }) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/settings");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await expect(page.locator("h1")).toContainText("Settings");
  await expect(page.locator("li")).toHaveCount(3);
});

// ---------------------------------------------------------------------------
// Route state JSON (client-side navigation)
// ---------------------------------------------------------------------------

test("route state request returns JSON", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.data.highlights).toContain("Hybrid route manifest");
});

test("route state request uses the configured loader cache duration", async ({ request }) => {
  const response = await request.get("/pricing", {
    headers: { "x-pracht-route-state-request": "1" },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, max-age=60");
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

test("unmatched route returns 404", async ({ request }) => {
  const response = await request.get("/nonexistent-page");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client-side navigation
// ---------------------------------------------------------------------------

test("clicking a link navigates without full page reload", async ({ page }) => {
  await page.goto("/");
  // Wait for hydration
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Capture a page-level reference to detect full reloads
  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Click the pricing link
  await page.click('a[href="/pricing"]');

  // The URL should update
  await page.waitForURL("/pricing");

  // The token should still exist (no full reload)
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);

  // Pricing content should render
  await expect(page.locator("h1")).toContainText("MVP plan");
});

test("client-side navigation updates shell when crossing shell boundaries", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "session", value: "abc123", domain: "localhost", path: "/" }]);

  await page.goto("/dashboard");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // We're in the app shell
  await expect(page.locator(".app-shell")).toBeVisible();

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to home (public shell)
  await page.click('a[href="/"]');
  await page.waitForURL("/");

  // Should now be in public shell
  await expect(page.locator(".public-shell")).toBeVisible();

  // Still a client-side navigation
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("back button works with client-side navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  // Navigate to pricing
  await page.click('a[href="/pricing"]');
  await page.waitForURL("/pricing");
  await expect(page.locator("h1")).toContainText("MVP plan");

  // Go back
  await page.goBack();
  await page.waitForURL("/");

  // Home content should render
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  // Token still alive — no full reload during back navigation either
  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("same-shell navigation preserves shell and updates route content", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Verify we're on home in public shell
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("explicit app manifest");

  // Navigate to pricing (same public shell)
  await page.click('a[href="/pricing"]');
  await page.waitForURL("/pricing");

  // Shell still present, content changed
  await expect(page.locator(".public-shell")).toBeVisible();
  await expect(page.locator("h1")).toContainText("MVP plan");
});

// ---------------------------------------------------------------------------
// Dynamic route with useParams
// ---------------------------------------------------------------------------

test("product page renders with useParams showing the route param", async ({ page }) => {
  await page.goto("/products/1");

  await expect(page.locator(".product-page")).toBeVisible();
  await expect(page.locator(".product-id")).toContainText("Product ID: 1");
  await expect(page.locator("h1")).toContainText("Widget");
});

test("product page SSR HTML contains params from useParams", async ({ request }) => {
  const response = await request.get("/products/2");
  const html = await response.text();

  expect(html).toContain("Product ID: 2");
  expect(html).toContain("Gadget");
});

test("client-side navigation to product page renders useParams correctly", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.evaluate(() => (window as any).__PRACHT_NAVIGATE__("/products/1"));
  await page.waitForURL("/products/1");

  await expect(page.locator(".product-id")).toContainText("Product ID: 1");
  await expect(page.locator("h1")).toContainText("Widget");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

test("typed Link, href helper, and route-object navigation work in manifest apps", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  await expect(page.locator('a[href="/products/1?ref=typed-link"]')).toContainText(
    "View typed product",
  );
  await expect(page.locator('a[href="/pricing?ref=typed-helper"]')).toContainText(
    "Pricing via href()",
  );

  await page.evaluate(() => {
    (window as any).__NAV_TOKEN__ = true;
  });

  await page.click('a[href="/products/1?ref=typed-link"]');
  await page.waitForURL("/products/1?ref=typed-link");
  await expect(page.locator(".product-id")).toContainText("Product ID: 1");

  await page.goBack();
  await page.waitForURL("/");
  await page.click("#typed-product-button");
  await page.waitForURL("/products/2?ref=typed-button");
  await expect(page.locator(".product-id")).toContainText("Product ID: 2");
  await expect(page.locator("h1")).toContainText("Gadget");

  const tokenSurvived = await page.evaluate(() => (window as any).__NAV_TOKEN__ === true);
  expect(tokenSurvived).toBe(true);
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

test("GET /api/health returns JSON", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toMatchObject({ status: "ok" });
});

test("POST /api/echo echoes the request body", async ({ request }) => {
  const response = await request.post("/api/echo", {
    data: { message: "hello" },
  });
  expect(response.status()).toBe(200);

  const json = await response.json();
  expect(json).toEqual({ echo: { message: "hello" } });
});

test("PUT /api/health returns 405", async ({ request }) => {
  const response = await request.put("/api/health");
  expect(response.status()).toBe(405);
});

test("GET /api/nonexistent falls through to 404", async ({ request }) => {
  const response = await request.get("/api/nonexistent");
  expect(response.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Server-Sent Events: /api/live (createEventStream) + /live (useEventSource)
// ---------------------------------------------------------------------------

test("live page opens an SSE connection and renders streamed events", async ({ page }) => {
  await page.goto("/live");

  // The hook reports the EventSource lifecycle...
  await expect(page.getByTestId("live-status")).toHaveText("open", { timeout: 10_000 });
  // ...and streamed `tick` events reach the DOM. Asserting on tick content
  // proves the whole chain: createEventStream wire format → dev-server
  // streaming (not buffering) → EventSource parse → JSON option → render.
  await expect(page.getByTestId("live-tick")).toContainText("tick", { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

test("page hydrates without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });

  await page.goto("/");
  // Wait for hydration to complete
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);

  // Filter out known non-critical warnings
  const criticalErrors = errors.filter((e) => !e.includes("[vite]") && !e.includes("404"));
  expect(criticalErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// <Script> loading strategies
// ---------------------------------------------------------------------------

test('<Script strategy="beforeHydration"> is in the SSR head; afterHydration injects client-side', async ({
  page,
  request,
}) => {
  const response = await request.get("/");
  const html = await response.text();

  // beforeHydration lands in the document <head>, like head() scripts.
  const headEnd = html.indexOf("</head>");
  const beforeIndex = html.indexOf('<script id="home-before-hydration">');
  expect(beforeIndex).toBeGreaterThan(-1);
  expect(beforeIndex).toBeLessThan(headEnd);
  expect(html).toContain("window.__prachtBeforeHydration = true;");

  // Client strategies render nothing server-side.
  expect(html).not.toContain('id="home-after-hydration"');

  await page.goto("/");
  await page.waitForFunction(() => (window as any).__prachtBeforeHydration === true);

  // afterHydration script is injected (and runs) once hydration completes.
  await expect(page.locator("html")).toHaveAttribute("data-after-hydration-script", "ran");

  // Dedupe: navigating away and back client-side must not inject it again.
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
  await page.click('a[href="/pricing"]');
  await page.waitForURL("/pricing");
  await page.click('a[href="/"]');
  await page.waitForURL("/");
  await expect(page.locator("html")).toHaveAttribute("data-after-hydration-script", "ran");
  const count = await page.locator('script[id="home-after-hydration"]').count();
  expect(count).toBe(1);
});
