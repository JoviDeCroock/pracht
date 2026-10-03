import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { acquireE2EWorkerPort, type E2EWorkerPortLease } from "./ports.ts";

// `pracht({ client: { islandsNavigation: true } })` production coverage: builds
// examples/islands with the flag on and proves in a real browser that links
// between islands pages swap the page into the same document — the shell
// island keeps its state, the new page's islands and stylesheets arrive, the
// old page's leave, back/forward restore content and scroll — while a link to
// a full-hydration route still loads a new document, and a navigation
// interrupted by another never lands.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("islands navigation swaps islands pages in place", async ({ page }) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-islands-navigation-"));
  const exampleDir = resolve(tempDir, "project");
  let server: ReturnType<typeof spawn> | undefined;
  let portLease: E2EWorkerPortLease | undefined;

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    const configPath = resolve(exampleDir, "vite.config.ts");
    const config = readFileSync(configPath, "utf-8");
    const enabled = config.replace(
      "pracht({ adapter: nodeAdapter() })",
      "pracht({ adapter: nodeAdapter(), client: { islandsNavigation: true } })",
    );
    expect(enabled).not.toBe(config);
    writeFileSync(configPath, enabled);

    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
      stdio: "pipe",
    });

    portLease = await acquireE2EWorkerPort();
    const { port } = portLease;
    server = spawn(process.execPath, [resolve(exampleDir, "dist/server/server.js")], {
      cwd: exampleDir,
      env: { ...process.env, PORT: String(port) },
      stdio: "pipe",
    });
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(`${origin}/guide`);

    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
    });
    const sameDocument = () => page.evaluate(() => (window as { marker?: string }).marker);
    const counterStylesheets = () =>
      page.locator('head link[rel="stylesheet"][href*="/assets/Counter-"]').count();

    await page.goto(`${origin}/guide`);
    await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
    await page.evaluate(() => {
      (window as { marker?: string }).marker = "first document";
      // Tall enough to scroll, so traversal can be checked for restoring it.
      document.body.style.minHeight = "4000px";
    });
    await page.getByTestId("shell-increment").click();
    await page.getByTestId("shell-increment").click();
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    expect(await counterStylesheets()).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 900));

    // Islands page to islands page: same document, new content, new title, the
    // shell island carried over with its state, the new island hydrated with
    // its stylesheet, and the page scrolled to the top.
    // Clicked in place: Playwright's own click would scroll the link into view
    // first and move the position this page should come back to.
    await page.evaluate(() =>
      document.querySelector<HTMLAnchorElement>('nav a[href="/guide/next"]')!.click(),
    );
    await expect(page.locator("h1")).toHaveText("Next page");
    expect(await sameDocument()).toBe("first document");
    await expect(page).toHaveTitle("Next — Pracht Islands Example");
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.waitForSelector('html[data-pracht-islands-hydrated="true"]');
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 2");
    expect(await counterStylesheets()).toBe(1);

    // Back: the old page returns, its scroll position with it, and the island
    // and stylesheet only the other page had are gone.
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Guide");
    expect(await sameDocument()).toBe("first document");
    await expect(page).toHaveURL(`${origin}/guide`);
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    await expect(page.locator('pracht-island[island="/src/islands/Counter.tsx"]')).toHaveCount(0);
    expect(await counterStylesheets()).toBe(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);

    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Next page");
    expect(await sameDocument()).toBe("first document");

    // An islands page to a hydration: "none" page is a swap as well.
    await page.click('nav a[href="/static"]');
    await expect(page.locator("h1")).toHaveText("Fully static");
    expect(await sameDocument()).toBe("first document");
    await expect(page.locator("pracht-island")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Next page");

    // A navigation interrupted by another never lands: the slow page is
    // dropped and the second link wins.
    await page.route(`${origin}/guide`, async (route) => {
      await new Promise((settle) => setTimeout(settle, 1_500));
      await route.continue().catch(() => {});
    });
    await page.click('nav a[href="/guide"]');
    await page.click('nav a[href="/static"]');
    await expect(page.locator("h1")).toHaveText("Fully static");
    await page.waitForTimeout(2_000);
    await expect(page.locator("h1")).toHaveText("Fully static");
    await expect(page).toHaveURL(`${origin}/static`);
    expect(await sameDocument()).toBe("first document");
    await page.unroute(`${origin}/guide`);
    expect(documents).toEqual(["/guide"]);

    // The interrupted navigation had already committed its history entry, as
    // a client-router push does; going back to it shows that page.
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Guide");

    // A full-hydration route still loads its own document, and hydrates.
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Next page");
    await page.click('nav a[href="/full"]');
    await page.waitForSelector('html[data-pracht-hydrated="true"]');
    expect(await sameDocument()).toBeUndefined();
    await expect(page).toHaveURL(`${origin}/full`);
    await page.getByTestId("full-button").click();
    await expect(page.getByTestId("full-button")).toHaveText("hydrated");
    expect(documents).toEqual(["/guide", "/full"]);
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    portLease?.release();
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
