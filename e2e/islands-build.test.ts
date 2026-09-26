import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { acquireE2EWorkerPort, type E2EWorkerPortLease } from "./ports.ts";

// Islands architecture (partial hydration) production coverage: builds
// examples/islands with the Node adapter and proves in a real browser that
// (a) islands hydrate and are interactive,
// (b) non-island server components never hydrate,
// (c) islands routes load only the islands bootstrap + island chunks — never
//     the full client runtime/router entry,
// (d) `client="visible"` islands hydrate (and fetch their chunk) only after
//     scrolling into view, and
// (e) `hydration: "none"` routes ship zero JavaScript and still receive their
//     stylesheet together with the assets it references and the ones they
//     import into their markup, including the CSS of an island they render as
//     a plain component.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("islands build hydrates islands only and ships minimal JS", async ({ page }) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-islands-build-"));
  const exampleDir = resolve(tempDir, "project");
  let server: ReturnType<typeof spawn> | undefined;
  let portLease: E2EWorkerPortLease | undefined;

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });

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
    ) as Record<string, { file: string; src?: string; css?: string[] }>;
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
    // An island is its own client entry, so its CSS is outside the route and
    // shell chunks. It still has to be in the document, and only where the
    // island rendered: Counter's stylesheet on the home page, LazyBox's not.
    const counterCssUrl = `/${
      Object.values(manifest).find((entry) => entry.src?.endsWith("islands/Counter.tsx"))!.css![0]
    }`;
    const lazyBoxCssUrl = `/${
      Object.values(manifest).find((entry) => entry.src?.endsWith("islands/LazyBox.tsx"))!.css![0]
    }`;
    expect(homeHtml).toContain(`<link rel="stylesheet" href="${counterCssUrl}">`);
    expect(homeHtml).not.toContain(lazyBoxCssUrl);
    const lazyHtml = readFileSync(resolve(exampleDir, "dist/client/lazy/index.html"), "utf-8");
    expect(lazyHtml).toContain(`<link rel="stylesheet" href="${lazyBoxCssUrl}">`);
    expect(lazyHtml).not.toContain(counterCssUrl);

    // An island on a route that ships no JavaScript renders as a plain
    // component. Its stylesheet — and the card it shares with the route — is
    // bundled into the server entry unless islands are chunked apart, and the
    // page linked neither. It must also be the copy the client build already
    // published, not a second one under its own URL.
    const staticIslandHtml = readFileSync(
      resolve(exampleDir, "dist/client/static-island/index.html"),
      "utf-8",
    );
    expect(staticIslandHtml).not.toContain("<script");
    expect(staticIslandHtml).toContain(`<link rel="stylesheet" href="${counterCssUrl}">`);
    const counterCss = readFileSync(resolve(exampleDir, `dist/client${counterCssUrl}`), "utf-8");
    expect(counterCss).toContain(".counter");
    expect(counterCss).toContain(".card");
    expect(staticIslandHtml.match(/rel="stylesheet"/g)).toHaveLength(1);

    const staticHtml = readFileSync(resolve(exampleDir, "dist/client/static/index.html"), "utf-8");
    expect(staticHtml).not.toContain("<script");
    expect(staticHtml).not.toContain("<pracht-island");

    // A hydration-none route's stylesheet comes out of the server build, and so
    // does every asset it points at. Copying the stylesheet without them ships
    // a document whose background image 404s.
    const staticCssUrl = staticHtml.match(/<link rel="stylesheet" href="([^"]+)">/)?.[1];
    expect(staticCssUrl).toBeTruthy();
    const staticCss = readFileSync(resolve(exampleDir, `dist/client${staticCssUrl}`), "utf-8");
    const referencedAsset = staticCss.match(/url\(["']?([^)"']+)["']?\)/)?.[1];
    expect(referencedAsset).toMatch(/^\/assets\/dots-[^/]+\.svg$/);
    expect(existsSync(resolve(exampleDir, `dist/client${referencedAsset}`))).toBe(true);

    // The same holds for an asset the route imports into its markup: the module
    // carrying the URL is server-side only, so the file behind it is emitted by
    // the server build and nowhere else.
    const importedAsset = staticHtml.match(/<img[^>]*id="static-glyph"[^>]*src="([^"]+)"/)?.[1];
    expect(importedAsset).toMatch(/^\/assets\/glyph-[^/]+\.svg$/);
    expect(existsSync(resolve(exampleDir, `dist/client${importedAsset}`))).toBe(true);

    expect(existsSync(resolve(exampleDir, "dist/client/lazy/index.html"))).toBe(true);

    // --- Behavior in a real browser --------------------------------------
    portLease = await acquireE2EWorkerPort();
    const { port } = portLease;
    server = spawn(process.execPath, [resolve(exampleDir, "dist/server/server.js")], {
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

    // (f) Request-time regions. The prerendered document carries the
    // fallback and the swap script; the region's content is fetched per
    // visitor from the region endpoint, so the cached HTML never changes.
    const regionsEntryUrl = `/${manifest["virtual:pracht/regions-client"].file}`;
    const regionsHtml = readFileSync(
      resolve(exampleDir, "dist/client/regions/index.html"),
      "utf-8",
    );
    expect(regionsHtml).toContain("<pracht-region");
    expect(regionsHtml).toContain("Loading visitor…");
    expect(regionsHtml).toContain(`<script type="module" src="${regionsEntryUrl}"></script>`);
    // Pages that render no region never reference the swap script.
    expect(staticHtml).not.toContain(regionsEntryUrl);
    expect(homeHtml).not.toContain(regionsEntryUrl);

    const anonymousDocument = await (await fetch(`${origin}/regions`)).text();
    const visitorDocument = await (
      await fetch(`${origin}/regions`, { headers: { cookie: "visitor=Ada" } })
    ).text();
    expect(visitorDocument).toBe(anonymousDocument);

    jsRequests.length = 0;
    await page.goto(`${origin}/regions`);
    await page.waitForSelector('html[data-pracht-regions-ready="true"]');
    await expect(page.getByTestId("visitor")).toHaveText("Signed out");
    // A hydration: "none" page with a region loads the swap script and
    // nothing else — no Preact, no client runtime.
    expect(jsRequests).toContain(regionsEntryUrl);
    expect(jsRequests.some((url) => url.includes("vendor"))).toBe(false);
    expect(jsRequests).not.toContain(clientEntryUrl);

    await page.context().addCookies([{ name: "visitor", value: "Ada", url: origin }]);
    await page.reload();
    await page.waitForSelector('html[data-pracht-regions-ready="true"]');
    await expect(page.getByTestId("visitor")).toHaveText("Welcome back, Ada");

    // SSR renders the region inline, in the document itself.
    const ssrRegionHtml = await (
      await fetch(`${origin}/regions/ssr`, { headers: { cookie: "visitor=Ada" } })
    ).text();
    expect(ssrRegionHtml).toContain("Welcome back, Ada");
    expect(ssrRegionHtml).not.toContain(regionsEntryUrl);

    // Islands a region brings along hydrate once it is swapped in.
    await page.goto(`${origin}/regions/islands`);
    await expect(page.getByTestId("visitor")).toHaveText("Hello, Ada");
    await expect(page.locator('pracht-island[island="/src/islands/Counter.tsx"]')).toHaveAttribute(
      "data-hydrated",
      "true",
    );
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 2");
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
