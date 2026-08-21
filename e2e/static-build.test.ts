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
import { buildStaticRouteStateUrl } from "../packages/framework/src/runtime-static.ts";

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
  options?: { fallback?: string; base?: string },
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
    // A sub-path deploy: the host maps `<base>/x` onto `<root>/x` and knows
    // nothing outside it.
    if (options?.base) {
      if (pathname === options.base.slice(0, -1)) {
        res.writeHead(301, { location: options.base }).end();
        return;
      }
      if (!pathname.startsWith(options.base)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("outside base");
        return;
      }
      pathname = `/${pathname.slice(options.base.length)}`;
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

function buildExampleOutput(exampleDir: string, env: Record<string, string> = {}): string {
  return String(
    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-strip-types",
        ...env,
      },
      stdio: "pipe",
    }),
  );
}

function buildFailureOutput(exampleDir: string): string {
  try {
    buildExample(exampleDir);
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer };
    return String(failure.stderr ?? failure.message);
  }
  throw new Error("Expected the static build to fail.");
}

function doctorExample(exampleDir: string): {
  checks: Array<{ message: string; status: string }>;
  ok: boolean;
} {
  let output: string;
  try {
    output = String(
      execFileSync(process.execPath, [cliEntry, "doctor", "--json"], {
        cwd: exampleDir,
        env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
        stdio: "pipe",
      }),
    );
  } catch (error) {
    output = String((error as Error & { stdout?: Buffer }).stdout ?? "");
  }
  return JSON.parse(output);
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

    // Route-state files exist for routes whose loader or server-only head
    // metadata participates in client navigation. The shared shell has a head
    // export, so even loaderless pages carry font-head state.
    for (const path of [
      "/",
      "/about",
      "/plain",
      "/posts/hello-world",
      "/posts/second-post",
      "/dashboard",
    ].map((routePath) => buildStaticRouteStateUrl(routePath).slice(1))) {
      expect(existsSync(resolve(clientDir, path)), `${path} should exist`).toBe(true);
    }
    expect(existsSync(resolve(clientDir, `.${buildStaticRouteStateUrl("/items/42")}`))).toBe(false);

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
    expect(stateFileRequests.some((url) => url.endsWith(buildStaticRouteStateUrl("/about")))).toBe(
      true,
    );

    // Dynamic SSG route navigation, still client-side.
    await page.click('nav a[href="/posts/hello-world"]');
    await expect(page.locator("#post h1")).toHaveText("Hello world");
    await page.click('#post a[href="/posts/second-post"]');
    await expect(page.locator("#post h1")).toHaveText("Second post");

    // Loaderless SPA route: shell prerendered and component rendered
    // client-side. Its shared shell head still comes from static route state.
    await page.click('nav a[href="/dashboard"]');
    await expect(page.locator("#dashboard li").first()).toHaveText("Deploys");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);
    expect(
      stateFileRequests.some((url) => url.endsWith(buildStaticRouteStateUrl("/dashboard"))),
    ).toBe(true);

    // In-app navigation to a dynamic SPA route (no prerendered document, no
    // state file) stays client-side — it must
    // NOT fall back to a document load, which on a plain static host would
    // land the user on the 404 page for a perfectly routable URL.
    await page.click('#dashboard a[href="/items/42"]');
    await expect(page.locator("#item h1")).toHaveText("Item 42");
    await expect(page.locator("#item-note")).toHaveText("client-only route");
    await page.waitForURL(`${origin}/items/42`);
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);
    // And back out again, still client-side.
    await page.click('#item a[href="/dashboard"]');
    await expect(page.locator("#dashboard h1")).toHaveText("Dashboard");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // The entire session was static-host-shaped: no route-state header
    // requests, and nothing 404'd. `/items/:id` exports no getStaticPaths(),
    // so the build prerendered no path for it and no state file can exist —
    // the client never asks for one.
    expect(routeStateHeaderRequests).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(
      stateFileRequests.some((url) => url.endsWith(buildStaticRouteStateUrl("/items/42"))),
    ).toBe(false);

    // Direct load of an unknown URL: the host serves 404.html with a 404
    // status, and the hydrated page shows the *real* requested path.
    await page.goto(`${origin}/no/such/page`);
    await waitForRouter(page);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/no/such/page");
    await expect(page.locator("#not-found-data")).toHaveText("Built custom 404");
    // Navigating out of the 404 page is client-side again.
    await page.click('#not-found a[href="/"]');
    await expect(page.locator("#tagline")).toHaveText("Every page is a file.");

    // SPA deep link without a host rewrite: full-document load lands on the
    // 404 page (the documented limitation for non-enumerated SPA paths).
    await page.goto(`${origin}/items/42`);
    await waitForRouter(page);
    await expect(page.locator("#not-found h1")).toContainText("404");

    // With a host rewrite to 200.html, the same deep link boots the client
    // router, resolves the route from window.location, and renders without a
    // reload loop.
    fallbackServer = (await startDumbStaticHost(clientDir, { fallback: "200.html" })).server;
    const fallbackOrigin = `http://127.0.0.1:${(fallbackServer.address() as AddressInfo).port}`;

    await page.goto(`${fallbackOrigin}/items/42`);
    await expect(page.locator("#item h1")).toHaveText("Item 42");
    await expect(page.locator("#item-note")).toHaveText("client-only route");
    await expect(page).toHaveTitle("Pracht Static Example");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      "width=device-width, initial-scale=1",
    );
    // Navigation away from the fallback boot stays client-side.
    await page.evaluate(() => {
      (window as any).__NO_RELOAD__ = true;
    });
    await page.click('#item a[href="/dashboard"]');
    await expect(page.locator("#dashboard h1")).toHaveText("Dashboard");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);
    // In-app navigation back into the dynamic SPA route stays client-side on
    // the fallback host too (no bounce through the 200.html document).
    await page.click('#dashboard a[href="/items/42"]');
    await expect(page.locator("#item h1")).toHaveText("Item 42");
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // Unknown URLs through the fallback render the not-found page client-side.
    await page.goto(`${fallbackOrigin}/totally/unknown`);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/totally/unknown");
    await expect(page.locator("#not-found-data")).toHaveText("Built custom 404");

    // A dynamic SSG pattern can match a path getStaticPaths() did not emit.
    // The generic fallback must not render that route without its missing
    // build-time loader state; it remains a not-found path.
    await page.goto(`${fallbackOrigin}/posts/not-generated`);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/posts/not-generated");
    await expect(page.locator("#not-found-data")).toHaveText("Built custom 404");
  } finally {
    await stopServer(server);
    await stopServer(fallbackServer);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed validation: every request-runtime feature is a build error.
// ---------------------------------------------------------------------------

test("static export build fails closed on request-runtime features", async () => {
  test.setTimeout(180_000);

  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-invalid-");

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8")
        .replace(
          "export const app = defineApp({",
          'export const app = defineApp({\n  middleware: { auth: () => import("./middleware/auth.ts") },',
        )
        .replace(
          'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
          'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
        )
        .replace(
          'route("/plain", () => import("./routes/plain.tsx"), { id: "plain", render: "ssg" }),',
          'route("/plain", () => import("./routes/plain.tsx"), { id: "plain", render: "ssg", middleware: ["auth"] }),',
        )
        .replace(
          'id: "dashboard",\n        render: "spa",',
          'hydration: "islands",\n        id: "dashboard",\n        render: "spa",',
        ),
      "utf-8",
    );
    mkdirSync(resolve(exampleDir, "src/middleware"), { recursive: true });
    writeFileSync(
      resolve(exampleDir, "src/middleware/auth.ts"),
      "export async function middleware(_args: unknown, next: () => Promise<Response>) {\n  return next();\n}\n",
      "utf-8",
    );
    const dashboardPath = resolve(exampleDir, "src/routes/dashboard.tsx");
    writeFileSync(
      dashboardPath,
      `export function loader() { return { widgets: [] }; }\n${readFileSync(dashboardPath, "utf-8")}`,
      "utf-8",
    );
    mkdirSync(resolve(exampleDir, "src/api"), { recursive: true });
    writeFileSync(
      resolve(exampleDir, "src/api/health.ts"),
      "export function GET() {\n  return Response.json({ ok: true });\n}\n",
      "utf-8",
    );

    const output = buildFailureOutput(exampleDir);
    expect(output).toContain("Static export (@pracht/adapter-static) cannot build this app");
    expect(output).toContain('/about (render: "ssr")');
    expect(output).toContain("/dashboard");
    expect(output).toContain("Static SPA routes must be loaderless");
    expect(output).toContain('/dashboard (hydration: "islands")');
    expect(output).toContain("Static SPA routes must use full hydration");
    expect(output).toContain("/plain");
    expect(output).toContain("static host has no request runtime");
    expect(output).toContain("/api/health");
    expect(output).toContain("@pracht/adapter-node");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static doctor catches inline SPA loaders from live route metadata", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-doctor-loader-",
  );

  try {
    const dashboardPath = resolve(exampleDir, "src/routes/dashboard.tsx");
    writeFileSync(
      dashboardPath,
      `export function loader() { return { widgets: [] }; }\n${readFileSync(dashboardPath, "utf-8")}`,
      "utf-8",
    );

    const report = doctorExample(exampleDir);
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.message).join("\n")).toContain("/dashboard");
    expect(report.checks.map((check) => check.message).join("\n")).toContain(
      "Static SPA routes must be loaderless",
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static doctor trusts the resolved adapter when staticAdapter is only imported", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-doctor-resolved-target-",
  );

  try {
    const viteConfigPath = resolve(exampleDir, "vite.config.ts");
    writeFileSync(
      viteConfigPath,
      readFileSync(viteConfigPath, "utf-8").replace(
        /adapter: staticAdapter\([\s\S]*?\n      \),/,
        'adapter: { id: "node", serverImports: "", createServerEntryModule: () => "" },',
      ),
      "utf-8",
    );
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
      ),
      "utf-8",
    );

    const report = doctorExample(exampleDir);
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.checks.map((check) => check.message).join("\n")).not.toContain("Static export:");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static doctor resolves an imported custom static adapter", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-doctor-custom-target-",
  );

  try {
    const packagePath = resolve(exampleDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      dependencies: Record<string, string>;
    };
    delete packageJson.dependencies["@pracht/adapter-static"];
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");

    writeFileSync(
      resolve(exampleDir, "custom-static-adapter.ts"),
      [
        "export function customStaticAdapter() {",
        "  return {",
        '    id: "custom-static",',
        '    serverImports: "",',
        "    staticTarget: true,",
        '    createServerEntryModule: () => "",',
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(exampleDir, "vite.config.ts"),
      [
        'import { defineConfig } from "vite";',
        'import { pracht } from "@pracht/vite-plugin";',
        'import { customStaticAdapter } from "./custom-static-adapter";',
        "",
        "export default defineConfig({",
        "  plugins: [pracht({ adapter: customStaticAdapter() })],",
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
      ),
      "utf-8",
    );

    const report = doctorExample(exampleDir);
    const messages = report.checks.map((check) => check.message).join("\n");
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(false);
    expect(messages).toContain("Static export:");
    expect(messages).toContain('/about (render: "ssr")');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static doctor resolves an inline custom static adapter", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-doctor-inline-target-",
  );

  try {
    const packagePath = resolve(exampleDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      dependencies: Record<string, string>;
    };
    delete packageJson.dependencies["@pracht/adapter-static"];
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");

    writeFileSync(
      resolve(exampleDir, "vite.config.ts"),
      [
        'import { defineConfig } from "vite";',
        'import { pracht } from "@pracht/vite-plugin";',
        "",
        "const adapter = {",
        '  id: "custom-static",',
        '  serverImports: "",',
        "  staticTarget: true,",
        '  createServerEntryModule: () => "",',
        "};",
        "",
        "export default defineConfig({",
        "  plugins: [pracht({ adapter })],",
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
      ),
      "utf-8",
    );

    const report = doctorExample(exampleDir);
    const messages = report.checks.map((check) => check.message).join("\n");
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(false);
    expect(messages).toContain("Static export:");
    expect(messages).toContain('/about (render: "ssr")');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static doctor resolves a custom adapter from an unrecognized package", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-doctor-package-target-",
  );

  try {
    const packagePath = resolve(exampleDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      dependencies: Record<string, string>;
    };
    delete packageJson.dependencies["@pracht/adapter-static"];
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");

    const adapterPackageDir = resolve(exampleDir, "node_modules/custom-static-adapter");
    mkdirSync(adapterPackageDir, { recursive: true });
    writeFileSync(
      resolve(adapterPackageDir, "package.json"),
      `${JSON.stringify({ name: "custom-static-adapter", type: "module", version: "1.0.0" })}\n`,
      "utf-8",
    );
    writeFileSync(
      resolve(adapterPackageDir, "index.js"),
      [
        "export function customStaticAdapter() {",
        "  return {",
        '    id: "custom-static",',
        '    serverImports: "",',
        "    staticTarget: true,",
        '    createServerEntryModule: () => "",',
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(exampleDir, "vite.config.ts"),
      [
        'import { defineConfig } from "vite";',
        'import { pracht } from "@pracht/vite-plugin";',
        'import { customStaticAdapter } from "custom-static-adapter";',
        "// This custom target is not @pracht/adapter-node.",
        "",
        "export default defineConfig({",
        '  plugins: [pracht({ "adapter": customStaticAdapter() })],',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),',
        'route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssr" }),',
      ),
      "utf-8",
    );

    const report = doctorExample(exampleDir);
    const messages = report.checks.map((check) => check.message).join("\n");
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(false);
    expect(messages).toContain("Static export:");
    expect(messages).toContain('/about (render: "ssr")');
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

for (const scenario of [
  {
    name: "redirecting SSG loader",
    source:
      'export function loader() { return new Response(null, { status: 302, headers: { location: "/new" } }); }\nexport function Component() { return <main>old</main>; }\n',
    expected: "document request returned status 302 (redirect: /new)",
  },
  {
    name: "throwing SSG loader",
    source:
      'export function loader() { throw new Error("build data unavailable"); }\nexport function Component() { return <main>broken</main>; }\nexport function ErrorBoundary() { return <main>caught</main>; }\n',
    expected: "document request returned status 500",
  },
  {
    name: "successful non-HTML SSG loader response",
    source:
      'export function loader() { return new Response("raw body", { headers: { "content-type": "text/plain" } }); }\nexport function Component() { return <main>unused</main>; }\n',
    expected: 'failed to render SSG route "/about" as HTML',
  },
  {
    name: "invalid route-state response",
    source:
      'export function loader({ request }) { return request.headers.has("x-pracht-route-state-request") ? new Response("not json") : { ok: true }; }\nexport function Component() { return <main>state</main>; }\n',
    expected: "route-state request returned invalid JSON",
  },
]) {
  test(`static export build rejects ${scenario.name}`, () => {
    test.setTimeout(180_000);
    const { exampleDir, tempDir } = createTempExampleDir(
      staticFixtureDir,
      "pracht-static-loader-failure-",
    );

    try {
      writeFileSync(resolve(exampleDir, "src/routes/about.tsx"), scenario.source, "utf-8");
      const output = buildFailureOutput(exampleDir);
      expect(output).toContain(scenario.expected);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
}

test("static export build rejects dynamic SSG without getStaticPaths", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-missing-paths-",
  );

  try {
    const postPath = resolve(exampleDir, "src/routes/post.tsx");
    writeFileSync(
      postPath,
      readFileSync(postPath, "utf-8").replace(
        /export function getStaticPaths\(\): RouteParams\[\] \{[\s\S]*?\n\}/,
        "",
      ),
      "utf-8",
    );
    const output = buildFailureOutput(exampleDir);
    expect(output).toContain('dynamic SSG route "/posts/:slug"');
    expect(output).toContain("has no getStaticPaths() export");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export preflights concrete paths before writing reserved output", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-reserved-path-",
  );

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        'route("/posts/:slug", () => import("./routes/post.tsx"), { id: "post", render: "ssg" })',
        'route("/:section/:slug", () => import("./routes/post.tsx"), { id: "post", render: "ssg" })',
      ),
      "utf-8",
    );
    const postPath = resolve(exampleDir, "src/routes/post.tsx");
    writeFileSync(
      postPath,
      readFileSync(postPath, "utf-8").replace(
        "return Object.keys(POSTS).map((slug) => ({ slug }));",
        'return [{ section: "_pracht", slug: "owned" }];',
      ),
      "utf-8",
    );
    // The rewritten route gained a `:section` param, so the shell's typed link
    // to it needs one too — otherwise the render fails before the preflight
    // this test is about.
    const shellPath = resolve(exampleDir, "src/shells/site.tsx");
    writeFileSync(
      shellPath,
      readFileSync(shellPath, "utf-8").replace(
        'params={{ slug: "hello-world" }}',
        'params={{ section: "posts", slug: "hello-world" }}',
      ),
      "utf-8",
    );

    const output = buildFailureOutput(exampleDir);
    expect(output).toContain("reserved /_pracht/ output namespace");
    expect(output).toContain("/_pracht/owned");
    expect(existsSync(resolve(exampleDir, "dist/client/_pracht/owned/index.html"))).toBe(false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export deploys under a sub-path Vite base", async ({ page }) => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-base-");
  let server: Server | undefined;

  try {
    const viteConfigPath = resolve(exampleDir, "vite.config.ts");
    writeFileSync(
      viteConfigPath,
      readFileSync(viteConfigPath, "utf-8").replace(
        "export default defineConfig({",
        'export default defineConfig({\n  base: "/app/",',
      ),
      "utf-8",
    );
    // A route may legitimately begin with the same segment as the deploy
    // base. Prerender requests must still treat this as a base-free route path
    // and produce the browser URL /app/app/about.
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace('route("/about",', 'route("/app/about",'),
      "utf-8",
    );
    buildExample(exampleDir, { PRACHT_STATIC_FALLBACK: "200.html" });

    const clientDir = resolve(exampleDir, "dist/client");
    // Output paths are unchanged: the base is where the deploy is *served*,
    // not part of the tree.
    expect(existsSync(resolve(clientDir, "app/about/index.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "app/app"))).toBe(false);

    // Documents reference their assets and state under the base.
    const homeHtml = readFileSync(resolve(clientDir, "index.html"), "utf-8");
    expect(homeHtml).toContain('src="/app/assets/');
    expect(homeHtml).not.toMatch(/src="\/assets\//);

    server = (await startDumbStaticHost(clientDir, { base: "/app/", fallback: "200.html" })).server;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const failedRequests: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400) failedRequests.push(response.url());
    });

    await page.goto(`${origin}/app/`);
    await waitForRouter(page);
    await page.evaluate(() => ((window as any).__NO_RELOAD__ = true));

    // Client-side navigation, with its route-state fetch, under the base.
    await page.click('nav a[href="/app/app/about"]');
    await expect(page.locator("#about h1")).toBeVisible();
    await expect(page.locator("#about-path")).toHaveText("Served from: /app/app/about");
    await page.waitForURL(`${origin}/app/app/about`);
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // Dynamic SSG route, then back through history.
    await page.click('nav a[href="/app/posts/hello-world"]');
    await expect(page.locator("#post h1")).toHaveText("Hello world");
    await page.goBack();
    await page.waitForURL(`${origin}/app/app/about`);
    expect(await page.evaluate(() => (window as any).__NO_RELOAD__)).toBe(true);

    // A deep link into a dynamic SPA route resolves through the fallback.
    await page.goto(`${origin}/app/items/42`);
    await waitForRouter(page);
    await expect(page.locator("#item h1")).toHaveText("Item 42");

    // An unknown URL under the base renders the app's not-found page at the
    // path the visitor actually asked for.
    await page.goto(`${origin}/app/no/such/page`);
    await waitForRouter(page);
    await expect(page.locator("#not-found h1")).toContainText("404");
    await expect(page.locator("#requested-path")).toHaveText("/app/no/such/page");

    expect(failedRequests).toEqual([]);
  } finally {
    await stopServer(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export build rejects a CDN base", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-cdn-base-");

  try {
    const viteConfigPath = resolve(exampleDir, "vite.config.ts");
    writeFileSync(
      viteConfigPath,
      readFileSync(viteConfigPath, "utf-8").replace(
        "export default defineConfig({",
        'export default defineConfig({\n  base: "https://cdn.example.com/",',
      ),
      "utf-8",
    );

    // The CLI colorizes the backticked `base`, so match around it.
    const output = buildFailureOutput(exampleDir);
    expect(output).toContain('is set to "https://cdn.example.com/"');
    expect(output).toContain("root-absolute path base");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export build rejects a document-relative base after SSR normalization", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-relative-base-",
  );

  try {
    const viteConfigPath = resolve(exampleDir, "vite.config.ts");
    writeFileSync(
      viteConfigPath,
      readFileSync(viteConfigPath, "utf-8").replace(
        "export default defineConfig({",
        'export default defineConfig({\n  base: "./",',
      ),
      "utf-8",
    );

    const output = buildFailureOutput(exampleDir);
    expect(output).toContain('is set to "./"');
    expect(output).toContain("root-absolute path base");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export serves non-ASCII prerender paths on a URL-decoding host", async () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-encoded-");
  let server: Server | undefined;

  try {
    const postPath = resolve(exampleDir, "src/routes/post.tsx");
    writeFileSync(
      postPath,
      readFileSync(postPath, "utf-8").replace(
        '"second-post": { title: "Second post", body: "Another build-time post." },',
        '"second-post": { title: "Second post", body: "Another build-time post." },\n  "café": { title: "Café", body: "Unicode slug." },',
      ),
      "utf-8",
    );

    const output = buildExampleOutput(exampleDir);
    expect(output).toContain("/posts/caf%C3%A9");
    // Pages are written to the decoded path, because every mainstream static
    // host decodes the request before looking at the filesystem. The encoded
    // spelling would build fine and 404 for every ordinary link.
    expect(existsSync(resolve(exampleDir, "dist/client/posts/café/index.html"))).toBe(true);
    expect(existsSync(resolve(exampleDir, "dist/client/posts/caf%C3%A9/index.html"))).toBe(false);

    const host = await startDumbStaticHost(resolve(exampleDir, "dist/client"));
    server = host.server;

    // What a browser actually sends for a link to /posts/café.
    const response = await fetch(`${host.origin}/posts/${encodeURIComponent("café")}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Café");

    // The route-state file still keys off the raw encoded pathname, which is
    // what the client derives from location.pathname.
    const stateResponse = await fetch(
      `${host.origin}${buildStaticRouteStateUrl("/posts/caf%C3%A9")}`,
    );
    expect(stateResponse.status).toBe(200);
  } finally {
    await stopServer(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export warns when the SPA fallback has no notFound page to render", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-blank-");

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(/  notFound: \{[\s\S]*?\n  \},\n/, ""),
      "utf-8",
    );

    const output = buildExampleOutput(exampleDir, { PRACHT_STATIC_FALLBACK: "200.html" });
    expect(output).toContain("no unshadowed client-routable SPA catch-all matches every URL");
    expect(output).toContain("empty document with status 200");
    expect(existsSync(resolve(exampleDir, "dist/client/200.html"))).toBe(true);
    expect(existsSync(resolve(exampleDir, "dist/client/404.html"))).toBe(false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export does not publish framework metadata into the deploy directory", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(staticFixtureDir, "pracht-static-meta-");

  try {
    buildExampleOutput(exampleDir);
    const clientDir = resolve(exampleDir, "dist/client");

    // Only the Cloudflare worker reads these from the client output. A static
    // export has no runtime, so publishing them would ship the route list and
    // header policy as dead bytes in the directory users upload.
    expect(existsSync(resolve(clientDir, "_pracht/headers.json"))).toBe(false);
    expect(existsSync(resolve(clientDir, "_pracht/markdown.json"))).toBe(false);
    expect(existsSync(resolve(clientDir, "_pracht/isg.json"))).toBe(false);

    // Still written for build tooling and deploy reference.
    expect(existsSync(resolve(exampleDir, "dist/server/headers-manifest.json"))).toBe(true);
    expect(existsSync(resolve(exampleDir, "dist/server/markdown-manifest.json"))).toBe(true);

    // `pracht verify` reads this from the client output, and on a successful
    // build it is always an empty findings report.
    expect(existsSync(resolve(clientDir, "_pracht/env-safety.json"))).toBe(true);

    // The route-state tree is the one thing under _pracht/ a static deploy
    // genuinely serves.
    expect(existsSync(resolve(clientDir, "_pracht/state"))).toBe(true);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export emits 404.html when a broad dynamic SSG route exists", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-broad-dynamic-",
  );

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        "    ]),\n  ],",
        '    ]),\n    route("/:slug", () => import("./routes/landing.tsx"), { id: "landing", render: "ssg" }),\n  ],',
      ),
      "utf-8",
    );
    writeFileSync(
      resolve(exampleDir, "src/routes/landing.tsx"),
      'export function getStaticPaths() { return [{ slug: "landing" }]; }\nexport function Component({ params }: { params: { slug: string } }) { return <main>{params.slug}</main>; }\n',
      "utf-8",
    );

    buildExample(exampleDir);

    const notFoundHtml = readFileSync(resolve(exampleDir, "dist/client/404.html"), "utf-8");
    expect(notFoundHtml).toContain("404 — page not found");
    expect(notFoundHtml).not.toContain("<main>404.html</main>");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("static export build fails closed when a registered capability throws on import", () => {
  test.setTimeout(180_000);
  const { exampleDir, tempDir } = createTempExampleDir(
    staticFixtureDir,
    "pracht-static-capability-import-",
  );

  try {
    const routesPath = resolve(exampleDir, "src/routes.ts");
    writeFileSync(
      routesPath,
      readFileSync(routesPath, "utf-8").replace(
        "export const app = defineApp({",
        'export const app = defineApp({\n  capabilities: { broken: () => import("./capabilities/broken.ts") },',
      ),
      "utf-8",
    );
    mkdirSync(resolve(exampleDir, "src/capabilities"), { recursive: true });
    writeFileSync(
      resolve(exampleDir, "src/capabilities/broken.ts"),
      `function defineCapability<T>(definition: T): T { return definition; }
const broken = defineCapability({
  title: "Broken capability",
  description: "Throws while its module is evaluated.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: {} },
  effect: "read",
  expose: { http: true },
  run() { return {}; },
});
throw new Error("capability import exploded");
export default broken;
`,
      "utf-8",
    );

    const output = buildFailureOutput(exampleDir);
    expect(output).toContain("broken");
    expect(output).toContain("capability import exploded");
    expect(output).toContain("cannot be validated safely");
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
