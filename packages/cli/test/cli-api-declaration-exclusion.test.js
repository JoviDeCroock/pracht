import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  coreImportPath,
  createRepoTempDir,
  nodeAdapterImportPath,
  runCli,
  vitePluginImportPath,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("API declaration and test file exclusion", () => {
  it("omits src/api declarations, tests, and mocks from inspect, plan, typegen, and verify", () => {
    const appDir = createRepoTempDir("pracht-api-declaration-exclusion-");
    writeApp(appDir);

    const inspect = JSON.parse(runCli(["inspect", "api", "--json"], { cwd: appDir }).stdout);
    expect(inspect.api).toEqual([
      {
        file: "/src/api/health.ts",
        hasDefaultHandler: false,
        methods: ["GET"],
        path: "/api/health",
      },
    ]);

    const plan = JSON.parse(runCli(["plan", "--json"], { cwd: appDir }).stdout);
    expect(plan.live.api.map(({ file, path }) => ({ file, path }))).toEqual([
      { file: "/src/api/health.ts", path: "/api/health" },
    ]);

    runCli(["typegen", "--json"], { cwd: appDir });
    const declaration = readFileSync(resolve(appDir, "src/pracht.d.ts"), "utf-8");
    expect(declaration).toContain('"/api/health"');
    expect(declaration).not.toContain("/api/types.d");
    expect(declaration).not.toContain("/api/health.test");

    const verify = JSON.parse(runCli(["verify", "--json"], { cwd: appDir }).stdout);
    expect(verify.ok).toBe(true);
    expect(verify.checks).toContainEqual({
      message: "API route discovery resolved 1 route.",
      status: "ok",
    });
    expect(verify.checks).toContainEqual({
      message: "Loaded 1 discovered API route module into the app graph.",
      status: "ok",
    });
    const output = JSON.stringify({ inspect, plan, verify });
    expect(output).not.toContain("/api/types.d");
    expect(output).not.toMatch(/\.test|\.spec|__tests__|__mocks__/);
  }, 30_000);
});

function writeApp(appDir) {
  const vitePluginImport = pathToFileURL(vitePluginImportPath).href;
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify({ name: "api-declaration-exclusion", private: true, type: "module" }, null, 2),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImport)};

export default defineConfig({
  plugins: [pracht()],
  resolve: {
    alias: {
      "@pracht/adapter-node": ${JSON.stringify(nodeAdapterImportPath)},
      "@pracht/core": ${JSON.stringify(coreImportPath)},
    },
  },
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    `import { defineApp } from "@pracht/core";

export const app = defineApp({ routes: [] });
`,
  );
  writeProjectFile(
    appDir,
    "src/api/health.ts",
    `export function GET() {
  return Response.json({ ok: true });
}
`,
  );
  // Colocated tests would run their suite, and fail the build, if imported.
  const testSource = `import { test } from "node:test";
test("health", () => {});
export function GET() {
  return new Response("test file");
}
`;
  for (const file of [
    "src/api/health.test.ts",
    "src/api/health.spec.ts",
    "src/api/__tests__/helpers.ts",
    "src/api/__mocks__/db.ts",
  ]) {
    writeProjectFile(appDir, file, testSource);
  }
  writeProjectFile(
    appDir,
    "src/api/types.d.ts",
    `export interface InternalApiHelper {
  value: string;
}
`,
  );
}

function writeProjectFile(appDir, relativePath, contents) {
  const filePath = resolve(appDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf-8");
}
