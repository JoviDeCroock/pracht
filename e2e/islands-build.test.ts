import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// Islands architecture (partial hydration) production coverage: builds
// examples/islands with the Node adapter and proves in a real browser that
// (a) islands hydrate and are interactive,
// (b) non-island server components never hydrate,
// (c) islands routes load only the islands bootstrap + island chunks — never
//     the full client runtime/router entry,
// (d) `client="visible"` islands hydrate (and fetch their chunk) only after
//     scrolling into view, and
// (e) `hydration: "none"` routes ship zero JavaScript.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("islands build hydrates islands only and ships minimal JS", async ({ page }) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-islands-build-"));
  const exampleDir = resolve(tempDir, "project");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return !["dist", "test-results"].some((entry) =>
        source.includes(`/examples/islands/${entry}`),
      );
    },
    recursive: true,
  });

  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
    },
    stdio: "pipe",
  });

  // --- Static output shape ---------------------------------------------
  const manifest = JSON.parse(
    readFileSync(resolve(exampleDir, "dist/client/.vite/manifest.json"), "utf-8"),
  ) as Record<string, { file: string; src?: string }>;
  const clientEntryUrl = `/${manifest["virtual:pracht/client"].file}`;
  const islandsEntryUrl = `/${manifest["virtual:pracht/islands-client"].file}`;
  const counterChunkUrl = `/${
    Object.values(manifest).find((entry) => entry.src?.endsWith("islands/Counter.tsx"))!.file
  }`;
  const lazyBoxChunkUrl = `/${
    Object.values(manifest).find((entry) => entry.src?.endsWith("islands/LazyBox.tsx"))!.file
  }`;

  const homeHtml = readFileSync(resolve(exampleDir, "dist/client/index.html"), "utf-8");
  expect(homeHtml).toContain('<pracht-island island="/src/islands/Counter.tsx"');
  expect(homeHtml).toContain('props="{&quot;start&quot;:5}"');
  // Islands routes carry no hydration state and never reference the full
  // client runtime entry.
  expect(homeHtml).not.toContain('id="pracht-state"');
  expect(homeHtml).not.toContain(clientEntryUrl);
  expect(homeHtml).toContain(`<script type="module" src="${islandsEntryUrl}"></script>`);

  const staticHtml = readFileSync(resolve(exampleDir, "dist/client/static/index.html"), "utf-8");
  expect(staticHtml).not.toContain("<script");
  expect(staticHtml).not.toContain("<pracht-island");

  expect(existsSync(resolve(exampleDir, "dist/client/lazy/index.html"))).toBe(true);

  // --- Behavior in a real browser --------------------------------------
  const port = 4319;
  const server = spawn(process.execPath, [resolve(exampleDir, "dist/server/server.js")], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });

  const jsRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(".js")) {
      jsRequests.push(url.pathname);
    }
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    const origin = `http://127.0.0.1:${port}`;

    // (a) The counter island hydrates and is interactive.
    await page.goto(`${origin}/`);
    await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
    await expect(page.locator("pracht-island")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("count")).toHaveText("Count: 5");
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 6");

    // (b) The non-island server component never hydrates: its onClick is
    // dead — clicking must not change its text.
    await page.getByTestId("dead-button").click();
    await page.waitForTimeout(250);
    await expect(page.getByTestId("dead-button")).toHaveText("static");

    // (c) The islands route loaded only the bootstrap + the Counter island —
    // not the full client runtime and not the LazyBox island.
    expect(jsRequests).toContain(islandsEntryUrl);
    expect(jsRequests).toContain(counterChunkUrl);
    expect(jsRequests).not.toContain(clientEntryUrl);
    expect(jsRequests).not.toContain(lazyBoxChunkUrl);

    // (d) The `visible` island hydrates only after scrolling into view.
    jsRequests.length = 0;
    await page.goto(`${origin}/lazy`);
    await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
    const lazyIsland = page.locator('pracht-island[island="/src/islands/LazyBox.tsx"]');
    await expect(lazyIsland).not.toHaveAttribute("data-hydrated", "true");
    expect(jsRequests).not.toContain(lazyBoxChunkUrl);

    await page.getByTestId("reveal").scrollIntoViewIfNeeded();
    await expect(lazyIsland).toHaveAttribute("data-hydrated", "true");
    expect(jsRequests).toContain(lazyBoxChunkUrl);
    await page.getByTestId("reveal").click();
    await expect(page.getByTestId("revealed")).toHaveText("Hydrated below the fold!");

    // (e) The hydration: "none" route ships zero JavaScript.
    jsRequests.length = 0;
    await page.goto(`${origin}/static`);
    await expect(page.locator("h1")).toHaveText("Fully static");
    expect(jsRequests).toEqual([]);

    // SSR islands routes hydrate at request time too (idle strategy).
    await page.goto(`${origin}/ssr`);
    await page.waitForSelector('pracht-island[data-hydrated="true"]');
    await expect(page.getByTestId("count")).toHaveText("Count: 100");
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 101");

    // Full-hydration routes in the same app still load the regular client
    // runtime and hydrate the whole tree.
    jsRequests.length = 0;
    await page.goto(`${origin}/full`);
    await page.waitForSelector('html[data-pracht-hydrated="true"]');
    expect(jsRequests).toContain(clientEntryUrl);
    await page.getByTestId("full-button").click();
    await expect(page.getByTestId("full-button")).toHaveText("hydrated");
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    rmSync(tempDir, { force: true, recursive: true });
  }
});

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveDone) => {
    child.once("exit", () => resolveDone());
    setTimeout(() => resolveDone(), 5_000);
  });
}
