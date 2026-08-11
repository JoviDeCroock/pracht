import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { acquireE2EWorkerPort, type E2EWorkerPortLease } from "./ports.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/static");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("static adapter emits host config and serves every supported render mode", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-static-build-"));
  const exampleDir = resolve(tempDir, "project");
  let server: ReturnType<typeof spawn> | undefined;
  let portLease: E2EWorkerPortLease | undefined;

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });

    buildExample(exampleDir, "netlify");
    const clientDir = resolve(exampleDir, "dist/client");
    expect(readFileSync(resolve(clientDir, "_redirects"), "utf-8")).toContain(
      "/projects/:id  /_pracht/spa/projects-id.html  200",
    );
    expect(readFileSync(resolve(clientDir, "_headers"), "utf-8")).toContain(
      "x-content-type-options: nosniff",
    );

    buildExample(exampleDir, "vercel");
    const vercelOutput = resolve(exampleDir, ".vercel/output");
    const vercelConfig = JSON.parse(
      readFileSync(resolve(vercelOutput, "config.json"), "utf-8"),
    ) as { routes: Record<string, unknown>[]; version: number };
    expect(vercelConfig.version).toBe(3);
    expect(existsSync(resolve(vercelOutput, "functions"))).toBe(false);
    expect(vercelConfig.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/(.*)", continue: true }),
        expect.objectContaining({
          src: "^/projects/[^/]+/?$",
          dest: "/_pracht/spa/projects-id.html",
        }),
        expect.objectContaining({ status: 404, dest: "/404.html" }),
      ]),
    );

    const homeHtml = readFileSync(resolve(clientDir, "index.html"), "utf-8");
    const stylesheet = homeHtml.match(/<link rel="stylesheet" href="([^"]+\.css)">/)?.[1];
    expect(stylesheet).toBeTruthy();
    expect(existsSync(resolve(vercelOutput, `static${stylesheet}`))).toBe(true);
    expect(existsSync(resolve(clientDir, "_pracht/state/index.json"))).toBe(true);
    expect(existsSync(resolve(clientDir, "_pracht/state/docs/routing/index.json"))).toBe(true);
    expect(existsSync(resolve(clientDir, "about/index.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "counter/index.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "dashboard/index.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "_pracht/spa/projects-id.html"))).toBe(true);
    expect(existsSync(resolve(clientDir, "404.html"))).toBe(true);

    portLease = await acquireE2EWorkerPort();
    const origin = `http://127.0.0.1:${portLease.port}`;
    server = spawn(
      process.execPath,
      [cliEntry, "preview", "--skip-build", "--port", String(portLease.port)],
      {
        cwd: exampleDir,
        env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
        stdio: "pipe",
      },
    );
    await waitForServer(origin);

    const homeResponse = await page.goto(origin);
    expect(homeResponse?.status()).toBe(200);
    await page.waitForSelector('html[data-pracht-hydrated="true"]');
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 23)");

    // SSG navigation stays client-side and reads the build-time JSON snapshot.
    await page.evaluate(() => {
      (window as typeof window & { __staticDocumentToken?: string }).__staticDocumentToken =
        "same-document";
    });
    const snapshotRequest = page.waitForRequest((request) =>
      request.url().endsWith("/_pracht/state/docs/routing/index.json"),
    );
    await page.locator('a[href="/docs/routing"]').first().click();
    await snapshotRequest;
    await expect(page.getByTestId("doc-title")).toHaveText("Routing");
    expect(
      await page.evaluate(
        () => (window as typeof window & { __staticDocumentToken?: string }).__staticDocumentToken,
      ),
    ).toBe("same-document");

    // No-hydration pages are documents with CSS but no JavaScript.
    const aboutResponse = await page.goto(`${origin}/about`);
    expect(aboutResponse?.status()).toBe(200);
    await expect(page.getByTestId("about")).toHaveText("Zero JavaScript");
    expect(await page.locator("script").count()).toBe(0);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 23)");

    // Islands retain their narrow hydration behavior on a static host.
    await page.goto(`${origin}/counter`);
    await page.waitForSelector('pracht-island[data-hydrated="true"]');
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 4");

    // Concrete and dynamic SPA documents both boot from files alone.
    await page.goto(`${origin}/dashboard`);
    await expect(page.getByTestId("dashboard")).toHaveText("Dashboard");
    await expect(page.getByTestId("items")).toContainText("alpha");
    await page.goto(`${origin}/projects/42`);
    await expect(page.getByTestId("project-id")).toHaveText("Project id: 42");

    const notFoundResponse = await page.goto(`${origin}/missing/deep/path`);
    expect(notFoundResponse?.status()).toBe(404);
    await expect(page.getByTestId("not-found")).toHaveText("404 — page not found");
    await expect(page.getByTestId("requested-path")).toHaveText("/missing/deep/path");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 23)");

    const [aboutHeaders, assetHeaders] = await Promise.all([
      fetch(`${origin}/about`),
      fetch(`${origin}${stylesheet}`),
    ]);
    expect(aboutHeaders.headers.get("x-pracht-example")).toBe("about");
    expect(aboutHeaders.headers.get("x-content-type-options")).toBe("nosniff");
    expect(assetHeaders.headers.get("content-type")).toContain("text/css");
    expect(assetHeaders.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    portLease?.release();
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function buildExample(exampleDir: string, host: "netlify" | "vercel"): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      PRACHT_STATIC_HOST: host,
    },
    stdio: "pipe",
  });
}

async function waitForServer(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${origin}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveDone) => {
    child.once("exit", () => resolveDone());
    setTimeout(() => resolveDone(), 5_000);
  });
}
