import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const staticFixtureDir = resolve(repoRoot, "examples/static");
const islandsFixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

// ---------------------------------------------------------------------------
// A deliberately dumb static host (GitHub Pages-flavored): exact files,
// directory index.html behind a trailing-slash redirect, 404.html for misses
// — or a 200.html rewrite when configured. Zero framework code.
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

async function fileAt(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

async function startDumbStaticHost(
  root: string,
  options?: { fallback?: string },
): Promise<{ origin: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const base = join(root, safe);

    let filePath = await fileAt(base);
    let status = 200;

    if (!filePath) {
      const indexPath = await fileAt(join(base, "index.html"));
      if (indexPath && !pathname.endsWith("/")) {
        res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      filePath = indexPath;
    }

    if (!filePath && options?.fallback) {
      filePath = await fileAt(join(root, options.fallback));
    }
    if (!filePath) {
      filePath = await fileAt(join(root, "404.html"));
      status = 404;
    }
    if (!filePath) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }

    const body = await readFile(filePath);
    res
      .writeHead(status, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      })
      .end(body);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

function stopServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function createTempExampleDir(
  fixtureDir: string,
  prefix: string,
): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, prefix));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    return { exampleDir, tempDir };
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

function buildExample(exampleDir: string, env: Record<string, string> = {}): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      ...env,
    },
    stdio: "pipe",
  });
}

async function waitForRouter(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__PRACHT_ROUTER_READY__);
}

// ---------------------------------------------------------------------------
// Full static export: build once (with the SPA fallback enabled), serve
// dist/client with the dumb host, and drive a real browser through it.
// ---------------------------------------------------------------------------

test("static export serves a full app from a dumb static host with zero server", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-build-");
  let server: Server | undefined;
  let fallbackServer: Server | undefined;

  try {
    buildExample(exampleDir, { PRACHT_STATIC_FALLBACK: "200.html" });

    const clientDir = resolve(exampleDir, "dist/client");

    // Prerendered pages, SPA shell included.
    for (const path of [
      "index.html",
      "about/index.html",
      "plain/index.html",
      "posts/hello-world/index.html",
      "posts/second-post/index.html",
      "dashboard/index.html",
      "404.html",
      "200.html",
    ]) {
      expect(existsSync(resolve(clientDir, path)), `${path} should exist`).toBe(true);
    }

    // Route-state files exist exactly for the routes whose navigation fetches
    // state (loaderless /plain has none; non-enumerated /items/:id cannot).
    for (const path of [
      "_pracht/state/index.json",
      "_pracht/state/about/index.json",
      "_pracht/state/posts/hello-world/index.json",
      "_pracht/state/posts/second-post/index.json",
      "_pracht/state/dashboard/index.json",
    ]) {
      expect(existsSync(resolve(clientDir, path)), `${path} should exist`).toBe(true);
    }
    expect(existsSync(resolve(clientDir, "_pracht/state/plain/index.json"))).toBe(false);

    // State files carry the same payload the live endpoint would, as plain
    // JSON (loader HTML stays inert data, exactly like the live endpoint).
    const homeState = JSON.parse(
      readFileSync(resolve(clientDir, "_pracht/state/index.json"), "utf-8"),
    );
    expect(homeState.data.tagline).toBe("Every page is a file.");
    expect(homeState.data.unsafe).toContain("<script>");

    // The client bundle was compiled for the static target: no route-state
    // header requests can be issued from it.
    const bundleSources = readFileSync(resolve(clientDir, "index.html"), "utf-8");
    expect(bundleSources).not.toContain("_data=1");

    // No server bundle is required to serve the site.
    server = (await startDumbStaticHost(clientDir)).server;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const failedRequests: string[] = [];
    const routeStateHeaderRequests: string[] = [];
    const stateFileRequests: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400) failedRequests.push(response.url());
    });
    page.on("request", (request) => {
      if (request.headers()["x-pracht-route-state-request"]) {
        routeStateHeaderRequests.push(request.url());
      }
      if (request.url().includes("/_pracht/state/")) {
        stateFileRequests.push(request.url());
      }
    });

    // Initial document + hydration.
    await page.goto(`${origin}/`);
    await waitForRouter(page);
    await expect(page.locator("#tagline")).toHaveText("Every page is a file.");
    // Loader-provided markup is data, not HTML.
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();

    // Client-side navigation fetches the static state file, not the server.
    await page.evaluate(() => {
      (window as any).__NO_RELOAD__ = true;
    });
    await page.click('nav a[href="/about"]');
    await page.waitForURL(`${origin}/about`);
    await expect(page.locator("#built-at")).toContainText("Build time");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);
    expect(stateFileRequests.some((url) => url.endsWith("/_pracht/state/about/index.json"))).toBe(
      true,
    );

    // Dynamic SSG route navigation, still client-side.
    await page.click('nav a[href="/posts/hello-world"]');
    await expect(page.locator("#post h1")).toHaveText("Hello world");
    await page.click('#post a[href="/posts/second-post"]');
    await expect(page.locator("#post h1")).toHaveText("Second post");

    // SPA route: shell prerendered, loader data from the state file.
    await page.click('nav a[href="/dashboard"]');
    await expect(page.locator("#dashboard li").first()).toHaveText("Deploys");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // The entire session was static-host-shaped: no route-state header
    // requests, no failed requests.
    expect(routeStateHeaderRequests).toEqual([]);
    expect(failedRequests).toEqual([]);

    // Direct load of an unknown URL: the host serves 404.html with a 404
    // status, and the hydrated page shows the *real* requested path.
    await page.goto(`${origin}/no/such/page`);
    await waitForRouter(page);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/no/such/page");
    // Navigating out of the 404 page is client-side again.
    await page.click('#not-found a[href="/"]');
    await expect(page.locator("#tagline")).toHaveText("Every page is a file.");

    // SPA deep link without a host rewrite: full-document load lands on the
    // 404 page (the documented limitation for non-enumerated SPA paths).
    await page.goto(`${origin}/items/42`);
    await waitForRouter(page);
    await expect(page.locator("#not-found h1")).toContainText("404");

    // With a host rewrite to 200.html, the same deep link boots the client
    // router, resolves the route from window.location, and renders without
    // build-time data — and without a reload loop.
    fallbackServer = (await startDumbStaticHost(clientDir, { fallback: "200.html" })).server;
    const fallbackOrigin = `http://127.0.0.1:${(fallbackServer.address() as AddressInfo).port}`;

    await page.goto(`${fallbackOrigin}/items/42`);
    await expect(page.locator("#item h1")).toHaveText("Item 42");
    await expect(page.locator("#item-note")).toHaveText("no build-time data");
    // Navigation away from the fallback boot stays client-side.
    await page.evaluate(() => {
      (window as any).__NO_RELOAD__ = true;
    });
    await page.click('#item a[href="/dashboard"]');
    await expect(page.locator("#dashboard h1")).toHaveText("Dashboard");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // Unknown URLs through the fallback render the not-found page client-side.
    await page.goto(`${fallbackOrigin}/totally/unknown`);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/totally/unknown");
  } finally {
    await stopServer(server);
    await stopServer(fallbackServer);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed validation: SSR routes and API routes are build errors.
// ---------------------------------------------------------------------------

test("static export build fails closed on SSR routes and API routes", async () => {
  test.setTimeout(180_000);

  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-invalid-");

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
      ),
      "utf-8",
    );
    mkdirSync(resolve(exampleDir, "src/api"), { recursive: true });
    writeFileSync(
      resolve(exampleDir, "src/api/health.ts"),
      "export function GET() {\n  return Response.json({ ok: true });\n}\n",
      "utf-8",
    );

    let failure: Error | undefined;
    try {
      buildExample(exampleDir);
    } catch (error) {
      failure = error as Error;
    }

    expect(failure).toBeDefined();
    const output = String(
      (failure as Error & { stderr?: Buffer }).stderr ?? (failure as Error).message,
    );
    expect(output).toContain("Static export (@pracht/adapter-static) cannot build this app");
    expect(output).toContain('/about (render: "ssr")');
    expect(output).toContain("/api/health");
    expect(output).toContain("@pracht/adapter-node");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Islands app exported statically: islands hydrate, no state files for
// islands routes, MPA navigation works from plain files.
// ---------------------------------------------------------------------------

test("islands example exports statically and hydrates islands from a dumb host", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const { exampleDir, tempDir } = createTempExampleDir(islandsFixtureDir, "pracht-static-islands-");
  let server: Server | undefined;

  try {
    // Point the example at the static adapter instead of Node.
    const viteConfigPath = resolve(exampleDir, "vite.config.ts");
    writeFileSync(
      viteConfigPath,
      readFileSync(viteConfigPath, "utf-8")
        .replace(
          'import { nodeAdapter } from "@pracht/adapter-node";',
          'import { staticAdapter } from "@pracht/adapter-static";',
        )
        .replace("pracht({ adapter: nodeAdapter() })", "pracht({ adapter: staticAdapter() })"),
      "utf-8",
    );
    // The static adapter is not a dependency of the islands example; alias it
    // to the workspace package.
    const adapterLink = resolve(exampleDir, "node_modules/@pracht/adapter-static");
    if (!existsSync(adapterLink)) {
      cpSync(resolve(repoRoot, "packages/adapter-static"), adapterLink, { recursive: true });
    }
    // The /ssr route cannot be exported statically — flip it to ssg.
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replaceAll('render: "ssr",', 'render: "ssg",'),
      "utf-8",
    );

    buildExample(exampleDir);

    const clientDir = resolve(exampleDir, "dist/client");
    expect(existsSync(resolve(clientDir, "index.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "static/index.html"))).toBe(true);
    // Islands routes navigate full-document — no state files for them.
    expect(existsSync(resolve(clientDir, "_pracht/state/index.json"))).toBe(false);

    server = (await startDumbStaticHost(clientDir)).server;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await page.goto(`${origin}/`);
    // The counter island hydrates and responds to clicks.
    await page.waitForSelector("pracht-island button");
    const counter = page.locator("pracht-island button", { hasText: "Increment" });
    const before = await page.locator("pracht-island").first().textContent();
    await counter.click();
    await expect
      .poll(async () => page.locator("pracht-island").first().textContent())
      .not.toBe(before);

    // MPA navigation between islands pages is plain document loads.
    await page.click('a[href="/static"]');
    await page.waitForURL(`${origin}/static/`);
    await expect(page.locator("main")).toContainText("static");
  } finally {
    await stopServer(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});
