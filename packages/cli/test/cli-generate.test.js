import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  cliPath,
  createTempDir,
  repoRoot,
  runCli,
  writeManifestApp,
  writePagesApp,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli generate", () => {
  it("reports the published package version", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf-8"),
    );

    const env = { ...process.env };
    delete env.NODE_ENV;
    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe(packageJson.version);
  });

  it("scaffolds shell, middleware, route, and api modules for manifest apps", () => {
    const appDir = createTempDir("pracht-cli-manifest-");
    writeManifestApp(appDir);

    runCli(["generate", "shell", "--name", "app"], { cwd: appDir });
    runCli(["generate", "middleware", "--name", "auth"], { cwd: appDir });

    const apiResult = runCli(
      ["generate", "api", "--path", "/health", "--methods", "GET,POST", "--json"],
      { cwd: appDir },
    );
    const apiJson = JSON.parse(apiResult.stdout);

    runCli(
      [
        "generate",
        "route",
        "--path",
        "/dashboard",
        "--render",
        "isg",
        "--revalidate",
        "120",
        "--shell",
        "app",
        "--middleware",
        "auth",
        "--loader",
        "--error-boundary",
      ],
      { cwd: appDir },
    );

    const manifest = readFileSync(join(appDir, "src/routes.ts"), "utf-8");
    const shellSource = readFileSync(join(appDir, "src/shells/app.tsx"), "utf-8");
    const middlewareSource = readFileSync(join(appDir, "src/middleware/auth.ts"), "utf-8");
    const routeSource = readFileSync(join(appDir, "src/routes/dashboard.tsx"), "utf-8");
    const apiSource = readFileSync(join(appDir, "src/api/health.ts"), "utf-8");

    expect(apiJson).toMatchObject({
      created: ["src/api/health.ts"],
      kind: "api",
      ok: true,
      updated: [],
    });
    expect(shellSource).toContain("export function Shell({ children }: ShellProps)");
    expect(middlewareSource).toContain("export const middleware: MiddlewareFn");
    expect(routeSource).toContain("export async function loader(_args: LoaderArgs)");
    expect(routeSource).toContain("export function ErrorBoundary({ error }: ErrorBoundaryProps)");
    expect(apiSource).toContain("export function GET(_args: ApiRouteArgs)");
    expect(apiSource).toContain("export async function POST({ request }: ApiRouteArgs)");
    expect(manifest).toContain('import { defineApp, route, timeRevalidate } from "@pracht/core";');
    expect(manifest).toContain('shells: {\n    app: "./shells/app.tsx",\n  },');
    expect(manifest).toContain('middleware: {\n    auth: "./middleware/auth.ts",\n  },');
    expect(manifest).toContain('route("/dashboard", "./routes/dashboard.tsx", {');
    expect(manifest).toContain('shell: "app",');
    expect(manifest).toContain('middleware: ["auth"],');
    expect(manifest).toContain("revalidate: timeRevalidate(120)");
  });

  it("emits a Playwright smoke test alongside generated routes when e2e tooling exists", () => {
    const appDir = createTempDir("pracht-cli-smoke-");
    writeManifestApp(appDir);

    // No Playwright setup: no test emitted.
    runCli(["generate", "route", "--path", "/reports"], { cwd: appDir });
    expect(existsSync(join(appDir, "e2e/reports.spec.ts"))).toBe(false);

    // With an e2e directory the test is emitted by default.
    writeProjectFile(appDir, "e2e/.gitkeep", "");
    const result = JSON.parse(
      runCli(["generate", "route", "--path", "/blog/:slug", "--json"], { cwd: appDir }).stdout,
    );
    expect(result.created).toContain("e2e/blog-slug.spec.ts");
    expect(result.notes).toEqual([
      expect.stringContaining("npm install --save-dev @playwright/test"),
    ]);

    const testSource = readFileSync(join(appDir, "e2e/blog-slug.spec.ts"), "utf-8");
    expect(testSource).toContain('test("renders /blog/:slug"');
    expect(testSource).toContain('page.goto("/blog/example-slug")');
    expect(testSource).toContain('toHaveText("Slug")');

    // --no-test opts out even when the setup exists.
    runCli(["generate", "route", "--path", "/contact", "--no-test"], { cwd: appDir });
    expect(existsSync(join(appDir, "e2e/contact.spec.ts"))).toBe(false);
  });

  it("explains the Playwright dependency when --test forces a smoke test", () => {
    const appDir = createTempDir("pracht-cli-forced-smoke-");
    writeManifestApp(appDir);

    const result = JSON.parse(
      runCli(["generate", "route", "--path", "/reports", "--test", "--json"], {
        cwd: appDir,
      }).stdout,
    );

    expect(result.created).toContain("e2e/reports.spec.ts");
    expect(result.notes).toEqual([
      expect.stringContaining("The generated smoke test imports `@playwright/test`"),
    ]);
  });

  it("scaffolds pages-router routes without touching a manifest", () => {
    const appDir = createTempDir("pracht-cli-pages-");
    writePagesApp(appDir);

    runCli(["generate", "route", "--path", "/blog/:slug", "--render", "ssg", "--loader"], {
      cwd: appDir,
    });

    const routePath = join(appDir, "src/pages/blog/[slug].tsx");
    expect(existsSync(routePath)).toBe(true);

    const routeSource = readFileSync(routePath, "utf-8");
    expect(routeSource).toContain('export const RENDER_MODE = "ssg";');
    expect(routeSource).toContain("export function getStaticPaths()");
    expect(routeSource).toContain('slug: "example-slug"');
  });

  it("scaffolds the root pages-router _middleware file", () => {
    const appDir = createTempDir("pracht-cli-pages-middleware-");
    writePagesApp(appDir);

    runCli(["generate", "middleware", "--name", "_middleware"], { cwd: appDir });

    const middlewareSource = readFileSync(join(appDir, "src/pages/_middleware.ts"), "utf-8");
    expect(middlewareSource).toContain("export const middleware: MiddlewareFn");
  });

  it("rejects named pages-router middleware", () => {
    const appDir = createTempDir("pracht-cli-pages-middleware-named-");
    writePagesApp(appDir);

    const result = spawnSync(
      process.execPath,
      [cliPath, "generate", "middleware", "--name", "auth"],
      { cwd: appDir, encoding: "utf-8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("single root-level `_middleware.ts`");
    expect(existsSync(join(appDir, "src/pages/auth.ts"))).toBe(false);
    expect(existsSync(join(appDir, "src/middleware/auth.ts"))).toBe(false);
  });

  it("scaffolds pages-router ISG with its required policy", () => {
    const appDir = createTempDir("pracht-cli-pages-isg-");
    writePagesApp(appDir);

    runCli(["generate", "route", "--path", "/pricing", "--render", "isg", "--revalidate", "120"], {
      cwd: appDir,
    });

    const routeSource = readFileSync(join(appDir, "src/pages/pricing.tsx"), "utf-8");
    expect(routeSource).toContain('export const RENDER_MODE = "isg";');
    expect(routeSource).toContain("export const REVALIDATE = 120;");
  });

  it("rejects misplaced revalidation before creating a route file", () => {
    const appDir = createTempDir("pracht-cli-pages-invalid-revalidate-");
    writePagesApp(appDir);

    const result = spawnSync(
      process.execPath,
      [cliPath, "generate", "route", "--path", "/broken", "--render", "ssr", "--revalidate", "60"],
      { cwd: appDir, encoding: "utf-8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("only valid together");
    expect(existsSync(join(appDir, "src/pages/broken.tsx"))).toBe(false);
  });
});
