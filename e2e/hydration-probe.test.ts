import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { acquireE2EWorkerPort, type E2EWorkerPortLease } from "./ports.ts";

// `client: { hydrationWarnings: true }` keeps the hydration-mismatch reporter
// in a production build so the output that ships can be checked before it does.
// Built from examples/islands with a deliberate server/client drift planted on
// both an islands route and a full-hydration route, because the two install
// the reporter from different runtimes.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

const BANNER_SELECTOR = "#__pracht_hydration_mismatch__";

test("a probe build reports hydration mismatches that a default build never mentions", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-hydration-probe-"));
  const exampleDir = resolve(tempDir, "project");
  let server: ReturnType<typeof spawn> | undefined;
  let portLease: E2EWorkerPortLease | undefined;

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    plantMismatch(exampleDir);

    portLease = await acquireE2EWorkerPort();
    const { port } = portLease;
    const origin = `http://127.0.0.1:${port}`;

    // --- Default build: diagnostics are compiled out ----------------------
    build(exampleDir);
    server = serve(exampleDir, port);
    await waitForServer(`${origin}/`);

    expect(await visit(page, `${origin}/`)).toEqual({ banner: false, consoleErrors: [] });
    expect(await visit(page, `${origin}/full`)).toEqual({ banner: false, consoleErrors: [] });

    server.kill("SIGTERM");
    await waitForExit(server);
    server = undefined;

    // --- Probe build: the same pages report the drift ---------------------
    enableHydrationWarnings(exampleDir);
    build(exampleDir);
    server = serve(exampleDir, port);
    await waitForServer(`${origin}/`);

    const islandsRoute = await visit(page, `${origin}/`);
    expect(islandsRoute.banner).toBe(true);
    expect(islandsRoute.consoleErrors.join("\n")).toContain("Hydration mismatch");

    const fullRoute = await visit(page, `${origin}/full`);
    expect(fullRoute.banner).toBe(true);
    expect(fullRoute.consoleErrors.join("\n")).toContain("Hydration mismatch");
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    portLease?.release();
    rmSync(tempDir, { force: true, recursive: true });
  }
});

/**
 * Renders a different element on the server than in the browser, which is
 * exactly what Preact reports through the mismatch hook. Planted twice: as an
 * island (reported by the islands bootstrap) and inside a full-hydration route
 * (reported by the client router).
 */
function plantMismatch(exampleDir: string): void {
  writeFileSync(
    resolve(exampleDir, "src/islands/Drift.tsx"),
    [
      "export default function Drift() {",
      '  return typeof window === "undefined" ? (',
      '    <span data-testid="drift">server</span>',
      "  ) : (",
      '    <div data-testid="drift">client</div>',
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );

  const home = resolve(exampleDir, "src/routes/home.tsx");
  writeFileSync(
    home,
    readFileSync(home, "utf-8")
      .replace(
        'import Counter from "../islands/Counter.tsx";',
        'import Counter from "../islands/Counter.tsx";\nimport Drift from "../islands/Drift.tsx";',
      )
      .replace("<Counter start={5} />", "<Counter start={5} />\n      <Drift />"),
    "utf-8",
  );

  const full = resolve(exampleDir, "src/routes/full.tsx");
  writeFileSync(
    full,
    readFileSync(full, "utf-8").replace(
      "      <h1>Full hydration</h1>",
      [
        "      <h1>Full hydration</h1>",
        '      {typeof window === "undefined" ? (',
        '        <span data-testid="drift">server</span>',
        "      ) : (",
        '        <div data-testid="drift">client</div>',
        "      )}",
      ].join("\n"),
    ),
    "utf-8",
  );
}

function enableHydrationWarnings(exampleDir: string): void {
  const configPath = resolve(exampleDir, "vite.config.ts");
  const config = readFileSync(configPath, "utf-8").replace(
    "pracht({ adapter: nodeAdapter() })",
    "pracht({ adapter: nodeAdapter(), client: { hydrationWarnings: true } })",
  );
  expect(config).toContain("hydrationWarnings");
  writeFileSync(configPath, config, "utf-8");
}

function build(exampleDir: string): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
    stdio: "pipe",
  });
}

function serve(exampleDir: string, port: number): ReturnType<typeof spawn> {
  return spawn(process.execPath, [resolve(exampleDir, "dist/server/server.js")], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
}

async function visit(
  page: Page,
  url: string,
): Promise<{ banner: boolean; consoleErrors: string[] }> {
  const consoleErrors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  page.on("console", onConsole);
  try {
    await page.goto(url);
    await page.waitForFunction(
      (selector) =>
        document.querySelector(selector) !== null ||
        document.querySelector('[data-testid="drift"]')?.tagName === "DIV",
      BANNER_SELECTOR,
    );
    return { banner: (await page.locator(BANNER_SELECTOR).count()) > 0, consoleErrors };
  } finally {
    page.off("console", onConsole);
  }
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
