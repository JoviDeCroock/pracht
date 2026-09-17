import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../src/project.ts";
import type { Check } from "../src/verification-helpers.ts";
import { collectConfigChecks } from "../src/verification-checks.ts";

function project(rawConfig: string): ProjectConfig {
  return {
    additionalExtensions: [],
    additionalExtensionsIsStatic: true,
    apiDir: "/src/api",
    appFile: "/src/routes.ts",
    capabilitiesDir: "/src/capabilities",
    configFile: "/project/vite.config.ts",
    hasPrachtPlugin: true,
    middlewareDir: "/src/middleware",
    mode: "manifest",
    pagesDefaultRender: "ssr",
    pagesDefaultRenderIsStatic: true,
    pagesDir: "",
    rawConfig,
    root: "/project",
    routesDir: "/src/routes",
    serverDir: "/src/server",
    shellsDir: "/src/shells",
  };
}

function run(rawConfig: string): Check[] {
  const checks: Check[] = [];
  collectConfigChecks(project(rawConfig), checks, "vite.config.ts");
  return checks;
}

function errors(checks: Check[]): string[] {
  return checks.filter((check) => check.status === "error").map((check) => check.message);
}

describe("collectConfigChecks", () => {
  it("reports CSS code splitting switched off", () => {
    const messages = errors(
      run("export default defineConfig({ build: { cssCodeSplit: false }, plugins: [pracht()] });"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/cssCodeSplit/);
  });

  it("passes a config that leaves it alone, or mentions it only in a comment", () => {
    expect(errors(run("export default defineConfig({ plugins: [pracht()] });"))).toEqual([]);
    expect(
      errors(
        run(
          "// never set cssCodeSplit: false\nexport default defineConfig({ plugins: [pracht()] });",
        ),
      ),
    ).toEqual([]);
    expect(
      errors(
        run("export default defineConfig({ build: { cssCodeSplit: true }, plugins: [pracht()] });"),
      ),
    ).toEqual([]);
  });
});
