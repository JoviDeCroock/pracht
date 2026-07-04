import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectEnvLeakVerification,
  extractEnvSafetyAllowList,
  scanSourceForEnvLeaks,
} from "../src/verification-env.ts";
import type { ProjectConfig } from "../src/project.ts";
import type { Check } from "../src/verification-helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeProject(rawConfig = ""): ProjectConfig {
  const root = mkdtempSync(join(tmpdir(), "pracht-verify-env-"));
  tempDirs.push(root);
  return { rawConfig, root } as ProjectConfig;
}

describe("scanSourceForEnvLeaks", () => {
  it("flags non-public references and skips public/built-in/allowed ones", () => {
    const code = `a(process.env.API_SECRET, import.meta.env.PRACHT_PUBLIC_URL, import.meta.env.MODE, process.env.ALLOWED_ONE);`;

    expect(scanSourceForEnvLeaks(code, new Set(["ALLOWED_ONE"]))).toEqual([
      { accessor: "process.env", name: "API_SECRET" },
    ]);
  });
});

describe("extractEnvSafetyAllowList", () => {
  it("reads allow entries from the vite config source", () => {
    const allow = extractEnvSafetyAllowList(
      `export default defineConfig({
        plugins: [pracht({ envSafety: { allow: ["SENTRY_RELEASE", 'BUILD_ID'] } })],
      });`,
    );

    expect([...allow]).toEqual(["SENTRY_RELEASE", "BUILD_ID"]);
  });

  it("returns an empty set when envSafety is not configured", () => {
    expect(extractEnvSafetyAllowList("pracht({})").size).toBe(0);
  });
});

describe("collectEnvLeakVerification", () => {
  it("reports leaks found in dist/client chunks", () => {
    const project = makeProject();
    const assetsDir = join(project.root, "dist/client/assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "index-abc.js"), "const k = process.env.SESSION_SECRET;");

    const checks: Check[] = [];
    collectEnvLeakVerification(project, checks, { scope: "full" });

    const error = checks.find((check) => check.status === "error");
    expect(error?.message).toContain("process.env.SESSION_SECRET");
    expect(error?.message).toContain("index-abc.js");
  });

  it("passes clean output and respects the configured allowlist", () => {
    const project = makeProject('pracht({ envSafety: { allow: ["SENTRY_RELEASE"] } })');
    const assetsDir = join(project.root, "dist/client/assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(assetsDir, "index-abc.js"),
      "use(import.meta.env.PRACHT_PUBLIC_NAME, process.env.SENTRY_RELEASE);",
    );

    const checks: Check[] = [];
    collectEnvLeakVerification(project, checks, { scope: "full" });

    expect(checks.some((check) => check.status === "error")).toBe(false);
    expect(checks.some((check) => check.message.includes("no non-public env var"))).toBe(true);
  });

  it("skips scanning outside full scope and when no build output exists", () => {
    const project = makeProject();

    const changedChecks: Check[] = [];
    collectEnvLeakVerification(project, changedChecks, { scope: "changed" });
    expect(changedChecks).toEqual([]);

    const fullChecks: Check[] = [];
    collectEnvLeakVerification(project, fullChecks, { scope: "full" });
    expect(fullChecks.some((check) => check.message.includes("pracht build"))).toBe(true);
  });
});
