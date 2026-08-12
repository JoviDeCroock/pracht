import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBuildAnalysis } from "../src/build-analysis.ts";

const tempRoots: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pracht-build-analysis-"));
  const clientDir = join(root, "dist/client");
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  mkdirSync(join(root, "dist/server"), { recursive: true });
  writeFileSync(
    join(clientDir, "assets/entry.js"),
    "export const framework = 'pracht';\n",
    "utf-8",
  );
  writeFileSync(join(clientDir, "assets/home.js"), "export default function Home() {}\n", "utf-8");
  tempRoots.push(root);

  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    options: {
      analyze: true,
      analyzeJson: false,
      budgetFail: true,
      budgets: { "*": 1 },
      clientDir,
      clientEntryJs: ["/assets/entry.js"],
      color: false,
      islandFiles: [],
      islandsEntryJs: [],
      jsManifest: { "./routes/home.tsx": ["/assets/home.js"] },
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      output: {
        error: (message: string) => errors.push(message),
        log: (message: string) => logs.push(message),
        warn: (message: string) => warnings.push(message),
      },
      root,
      routes: [{ path: "/", render: "ssg", file: "./routes/home.tsx" }],
    },
    errors,
    logs,
    root,
    warnings,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

describe("runBuildAnalysis", () => {
  it("persists budget evidence and returns an explicit build failure", () => {
    const fixture = createFixture();

    const result = runBuildAnalysis(fixture.options);

    expect(result).toEqual({ shouldFailBuild: true });
    expect(fixture.logs.join("\n")).toContain("Route / chunk");
    expect(fixture.logs.join("\n")).toContain("FAIL");
    expect(fixture.errors.join("\n")).toContain("Build failed: client JS budget exceeded");
    expect(fixture.warnings).toEqual([]);

    const persisted = JSON.parse(
      readFileSync(join(fixture.root, "dist/server/budget-report.json"), "utf-8"),
    );
    expect(persisted).toMatchObject({
      generatedAt: "2026-08-12T12:00:00.000Z",
      budgets: { "*": 1 },
      ok: false,
    });
    expect(persisted.results).toHaveLength(1);
  });

  it("keeps JSON analysis machine-readable when budget failures are downgraded", () => {
    const fixture = createFixture();
    fixture.options.analyzeJson = true;
    fixture.options.budgetFail = false;

    const result = runBuildAnalysis(fixture.options);

    expect(result).toEqual({ shouldFailBuild: false });
    expect(fixture.errors).toEqual([]);
    expect(fixture.warnings).toEqual([]);
    expect(fixture.logs).toHaveLength(1);
    expect(JSON.parse(fixture.logs[0])).toMatchObject({
      budgets: { ok: false },
      routes: [{ path: "/" }],
    });
  });
});
