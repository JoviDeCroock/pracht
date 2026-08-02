import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCli,
  runCliStatus,
  writeInspectablePagesApp,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli typegen routes", () => {
  it("generates typed route declarations and href helpers for manifest apps", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-manifest-");
    writeTypedManifestApp(appDir);

    const result = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    const declaration = readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8");
    const runtime = readFileSync(join(appDir, "src/pracht-routes.ts"), "utf-8");

    expect(result).toMatchObject({
      apiRoutes: 3,
      check: false,
      files: ["src/pracht.d.ts", "src/pracht-routes.ts"],
      mode: "manifest",
      ok: true,
      routes: 3,
    });
    expect(declaration).toContain(
      'import type { ApiRouteMethodMap, RouteLoaderData, RouteParamInput, RouteSearchInput, RouteSearchOutput, SearchParamsInput } from "@pracht/core";',
    );
    expect(declaration).toContain('"home": {');
    expect(declaration).toContain("params: Record<never, never>;");
    expect(declaration).toContain('"product": {');
    expect(declaration).toContain('params: { "id": RouteParamInput; };');
    expect(declaration).toContain('search: RouteSearchInput<typeof import("./routes/product")>;');
    expect(declaration).toContain(
      'searchOutput: RouteSearchOutput<typeof import("./routes/product")>;',
    );
    // Route without a loader still points at its module; RouteLoaderData
    // resolves to undefined until a loader export appears.
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./routes/home")>;');
    // Inline loader.
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./routes/product")>;');
    // Manifest-wired separate loader file wins over the route module.
    expect(declaration).toContain(
      'data: RouteLoaderData<typeof import("./server/dashboard-loader"), typeof import("./routes/dashboard")>;',
    );
    // API routes register on Register["apiRoutes"] for the typed apiFetch client.
    expect(declaration).toContain("    apiRoutes: {");
    expect(declaration).toContain('"/api/items/:id": {');
    expect(declaration).toContain('methods: ApiRouteMethodMap<typeof import("./api/items/[id]")>;');
    expect(runtime).toContain('id: "product"');
    expect(runtime).toContain('path: "/products/:id"');
    expect(runtime).toContain("export const href = createHref(routes);");
    expect(existsSync(join(appDir, "api-module-loaded"))).toBe(false);

    const check = JSON.parse(runCli(["typegen", "--check", "--json"], { cwd: appDir }).stdout);
    expect(check).toMatchObject({ check: true, ok: true, routes: 3 });

    // Unchanged outputs are not rewritten — dev-mode regeneration relies on
    // this to avoid spurious HMR updates for the generated runtime module.
    const declarationPath = join(appDir, "src/pracht.d.ts");
    const past = new Date(Date.now() - 120_000);
    utimesSync(declarationPath, past, past);
    runCli(["typegen"], { cwd: appDir });
    expect(statSync(declarationPath).mtimeMs).toBeLessThan(Date.now() - 60_000);

    writeProjectFile(appDir, "src/pracht.d.ts", "stale\n");
    const stale = runCliStatus(["typegen", "--check", "--json"], { cwd: appDir });
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr)).toMatchObject({ ok: false });

    for (const [declarationOut, runtimeOut] of [
      ["src/collision.ts", "src/collision.ts"],
      ["src/collision.d.ts", "src/collision.tsx"],
    ]) {
      const collision = runCliStatus(
        ["typegen", "--out", declarationOut, "--runtime-out", runtimeOut, "--json"],
        { cwd: appDir },
      );
      expect(collision.status).toBe(1);
      expect(JSON.parse(collision.stderr)).toMatchObject({
        ok: false,
        error: expect.stringContaining("shares its basename"),
      });
    }
  }, 30_000);

  it("generates typed route declarations for pages-router apps", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-pages-");
    writeInspectablePagesApp(appDir);

    const result = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    const declaration = readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8");

    expect(result).toMatchObject({ mode: "pages", ok: true, routes: 2 });
    expect(declaration).toContain('"index": {');
    expect(declaration).toContain('"blog-slug": {');
    expect(declaration).toContain('params: { "slug": RouteParamInput; };');
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./pages/index")>;');
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./pages/blog/[slug]")>;');
  }, 30_000);
});
