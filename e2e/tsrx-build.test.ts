import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// End-to-end coverage for `.tsrx` route modules compiled by
// `@tsrx/vite-plugin-preact`. Builds `examples/tsrx/` in a temp dir, asserts
// that: the `.tsrx` route is prerendered with its scoped CSS, that a `.tsx`
// route and a `.tsrx` route coexist, that server-only exports from the `.tsrx`
// source are stripped from the client bundle, and that the built Node server
// serves both pages.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/tsrx");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht build prerenders a .tsrx route with scoped CSS and strips its loader from the client bundle", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempExampleDir("pracht-tsrx-build-");
  const distDir = resolve(exampleDir, "dist");

  rmSync(distDir, { force: true, recursive: true });

  buildExample(exampleDir);

  // --- Prerendered HTML ---
  const homeHtmlPath = resolve(exampleDir, "dist/client/index.html");
  const aboutHtmlPath = resolve(exampleDir, "dist/client/about/index.html");
  expect(existsSync(homeHtmlPath)).toBe(true);
  expect(existsSync(aboutHtmlPath)).toBe(true);

  const homeHtml = readFileSync(homeHtmlPath, "utf-8");
  // Loader data from the .tsrx route made it through SSR.
  expect(homeHtml).toContain("Hello from a .tsrx route");
  expect(homeHtml).toContain("Compiled by @tsrx/vite-plugin-preact");
  // Scoped class injected by @tsrx/vite-plugin-preact's CSS pipeline.
  expect(homeHtml).toMatch(/class="tsrx-home tsrx-[0-9a-z]+"/);
  // Hydration state is present.
  expect(homeHtml).toContain('id="pracht-state" type="application/json"');
  expect(homeHtml).toContain('"routeId":"home"');
  // Hashed client entry (not the dev-mode `/@pracht/client.js` alias).
  expect(homeHtml).toMatch(/<script type="module" src="\/assets\/client-[^"]+\.js"><\/script>/);

  // .tsx route coexists and renders.
  const aboutHtml = readFileSync(aboutHtmlPath, "utf-8");
  expect(aboutHtml).toContain("About this example");
  expect(aboutHtml).toContain('"routeId":"about"');

  // --- Scoped CSS extracted from the .tsrx <style> block ---
  const cssDir = resolve(exampleDir, "dist/client/assets");
  const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith(".css"));
  expect(cssFiles.length).toBeGreaterThan(0);
  const cssContents = cssFiles.map((f) => readFileSync(resolve(cssDir, f), "utf-8")).join("\n");
  // `.tsrx-home` should appear suffixed with the scope hash the HTML used.
  const hashMatch = homeHtml.match(/class="tsrx-home (tsrx-[0-9a-z]+)"/);
  expect(hashMatch).toBeTruthy();
  const scopeHash = hashMatch![1];
  expect(cssContents).toContain(`.tsrx-home.${scopeHash}`);
  expect(cssContents).toContain(`h1.${scopeHash}`);
  // `rebeccapurple` may be minified to `#639` — accept either.
  expect(cssContents.toLowerCase()).toMatch(/rebeccapurple|#663399|#639/);

  // --- Client bundle: loader + loader-only data must be stripped ---
  const clientJs = collectJsSource(cssDir);
  // Component content survives.
  expect(clientJs).toContain("This page is rendered from a .tsrx file.");
  // Loader-only strings — these appear in the route's loader return value,
  // not in the rendered markup — must not reach the client bundle.
  expect(clientJs).not.toContain("Hello from a .tsrx route");
  expect(clientJs).not.toContain("Compiled by @tsrx/vite-plugin-preact");

  // --- Server bundle: loader is retained ---
  const serverJs = collectJsSource(resolve(exampleDir, "dist/server"));
  expect(serverJs).toContain("Hello from a .tsrx route");
  expect(serverJs).toContain("Compiled by @tsrx/vite-plugin-preact");

  rmSync(tempDir, { force: true, recursive: true });
});

test("built Node server serves .tsrx and .tsx routes", async () => {
  test.setTimeout(120_000);

  const { exampleDir, tempDir } = createTempExampleDir("pracht-tsrx-serve-");
  const distDir = resolve(exampleDir, "dist");
  const serverEntryPath = resolve(exampleDir, "dist/server/server.js");

  rmSync(distDir, { force: true, recursive: true });

  buildExample(exampleDir);
  expect(existsSync(serverEntryPath)).toBe(true);

  const port = await getAvailablePort();
  const server = spawn(process.execPath, [serverEntryPath], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: "pipe",
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/`);

    const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
    expect(homeResponse.status).toBe(200);
    const homeHtml = await homeResponse.text();
    expect(homeHtml).toContain("Hello from a .tsrx route");
    expect(homeHtml).toMatch(/class="tsrx-home tsrx-[0-9a-z]+"/);

    const aboutResponse = await fetch(`http://127.0.0.1:${port}/about`);
    expect(aboutResponse.status).toBe(200);
    const aboutHtml = await aboutResponse.text();
    expect(aboutHtml).toContain("About this example");

    // Client-nav JSON endpoint returns the loader payload for the .tsrx route.
    const stateResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "x-pracht-route-state-request": "1" },
    });
    expect(stateResponse.status).toBe(200);
    expect(stateResponse.headers.get("content-type")).toContain("application/json");
    const state = (await stateResponse.json()) as {
      data: { greeting: string; features: string[] };
    };
    expect(state.data.greeting).toBe("Hello from a .tsrx route");
    expect(state.data.features).toContain("Mixes freely with .tsx routes");
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function createTempExampleDir(prefix: string): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, prefix));
  const exampleDir = resolve(tempDir, "project");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/tsrx/${entry}`),
      );
    },
    recursive: true,
  });

  return { exampleDir, tempDir };
}

function buildExample(exampleDir: string): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: "pipe",
  });
}

function collectJsSource(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  const pieces: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
    const parent =
      (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    pieces.push(readFileSync(resolve(parent, entry.name), "utf-8"));
  }
  return pieces.join("\n");
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolveDone) => {
    child.once("exit", () => resolveDone());
    setTimeout(() => resolveDone(), 5_000);
  });
}
