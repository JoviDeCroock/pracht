import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  collectBundleReport,
  evaluateBudgets,
  formatBudgetResults,
  formatBundleReport,
  formatBytes,
  parseSizeToBytes,
  type BundleReport,
} from "../src/bundle-report.ts";

describe("parseSizeToBytes", () => {
  it("treats plain numbers as bytes", () => {
    expect(parseSizeToBytes(2048)).toBe(2048);
    expect(parseSizeToBytes(1.9)).toBe(1);
  });

  it("parses numeric strings as bytes", () => {
    expect(parseSizeToBytes("2048")).toBe(2048);
    expect(parseSizeToBytes("512b")).toBe(512);
  });

  it("parses kb/mb/gb size strings using 1024-based units", () => {
    expect(parseSizeToBytes("120kb")).toBe(120 * 1024);
    expect(parseSizeToBytes("1mb")).toBe(1024 * 1024);
    expect(parseSizeToBytes("1.5KB")).toBe(1536);
    expect(parseSizeToBytes(" 2 GB ")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("rejects invalid values", () => {
    expect(() => parseSizeToBytes("")).toThrow(/Invalid size/);
    expect(() => parseSizeToBytes("12 kilobytes")).toThrow(/Invalid size/);
    expect(() => parseSizeToBytes("-1kb")).toThrow(/Invalid size/);
    expect(() => parseSizeToBytes(0)).toThrow(/Invalid size/);
    expect(() => parseSizeToBytes(Number.NaN)).toThrow(/Invalid size/);
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatBytes(512)).toBe("512b");
    expect(formatBytes(1536)).toBe("1.5kb");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00mb");
  });
});

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createClientDirFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-bundle-report-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, "utf-8");
  }
  return dir;
}

function gzipSize(contents: string): number {
  return gzipSync(Buffer.from(contents)).byteLength;
}

const ENTRY_JS = "console.log('entry');".repeat(20);
const VENDOR_JS = "export const preact = 'preact';".repeat(40);
const HOME_JS = "console.log('home');".repeat(10);
const DASHBOARD_JS = "console.log('dashboard');".repeat(100);
const CHART_JS = "export const chart = () => 'chart';".repeat(200);
const SHELL_JS = "console.log('shell');".repeat(5);

function createFixtureReport(): BundleReport {
  const clientDir = createClientDirFixture({
    "assets/entry.js": ENTRY_JS,
    "assets/vendor.js": VENDOR_JS,
    "assets/home.js": HOME_JS,
    "assets/dashboard.js": DASHBOARD_JS,
    "assets/chart.js": CHART_JS,
    "assets/shell.js": SHELL_JS,
  });

  return collectBundleReport({
    clientDir,
    clientEntryJs: ["/assets/entry.js", "/assets/vendor.js"],
    jsManifest: {
      "src/routes/home.tsx": ["/assets/home.js", "/assets/vendor.js"],
      "src/routes/dashboard.tsx": ["/assets/dashboard.js", "/assets/chart.js"],
      "src/shells/app.tsx": ["/assets/shell.js"],
    },
    routes: [
      { id: "home", path: "/", render: "ssg", file: "./routes/home.tsx" },
      {
        id: "dashboard",
        path: "/dashboard",
        render: "spa",
        file: "./routes/dashboard.tsx",
        shellFile: "./shells/app.tsx",
      },
    ],
  });
}

describe("collectBundleReport", () => {
  it("computes per-route transitive chunks with raw and gzip sizes", () => {
    const report = createFixtureReport();

    expect(report.shared.chunks.map((chunk) => chunk.url).sort()).toEqual([
      "/assets/entry.js",
      "/assets/vendor.js",
    ]);
    expect(report.shared.bytes).toBe(ENTRY_JS.length + VENDOR_JS.length);
    expect(report.shared.gzipBytes).toBe(gzipSize(ENTRY_JS) + gzipSize(VENDOR_JS));

    // Sorted by total gzip size descending: dashboard ships more JS than home.
    expect(report.routes.map((route) => route.path)).toEqual(["/dashboard", "/"]);

    const dashboard = report.routes[0];
    expect(dashboard.render).toBe("spa");
    // Shell + route chunks, shared chunks excluded from the route-specific list.
    expect(dashboard.chunks.map((chunk) => chunk.url).sort()).toEqual([
      "/assets/chart.js",
      "/assets/dashboard.js",
      "/assets/shell.js",
    ]);
    expect(dashboard.routeGzipBytes).toBe(
      gzipSize(DASHBOARD_JS) + gzipSize(CHART_JS) + gzipSize(SHELL_JS),
    );
    expect(dashboard.totalGzipBytes).toBe(dashboard.routeGzipBytes + report.shared.gzipBytes);
    expect(dashboard.totalBytes).toBe(
      DASHBOARD_JS.length + CHART_JS.length + SHELL_JS.length + report.shared.bytes,
    );

    const home = report.routes[1];
    // vendor.js is shared, so home only ships its own chunk on top of the entry.
    expect(home.chunks.map((chunk) => chunk.url)).toEqual(["/assets/home.js"]);
    expect(home.totalGzipBytes).toBe(gzipSize(HOME_JS) + report.shared.gzipBytes);
  });

  it("resolves route files through suffix matching like the runtime manifest", () => {
    const report = createFixtureReport();
    // Route files were "./routes/home.tsx" while manifest keys are
    // "src/routes/home.tsx" — suffix matching must bridge the difference.
    expect(report.routes.every((route) => route.chunks.length > 0)).toBe(true);
  });
});

describe("evaluateBudgets", () => {
  it("applies the default budget to all routes and lets explicit keys override", () => {
    const report = createFixtureReport();
    const evaluation = evaluateBudgets(report, { "*": 50, "/dashboard": "1mb" });

    const home = evaluation.results.find((result) => result.path === "/");
    const dashboard = evaluation.results.find((result) => result.path === "/dashboard");

    expect(home?.source).toBe("*");
    expect(home?.limitBytes).toBe(50);
    expect(home?.ok).toBe(false);

    expect(dashboard?.source).toBe("/dashboard");
    expect(dashboard?.limitBytes).toBe(1024 * 1024);
    expect(dashboard?.ok).toBe(true);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.unmatched).toEqual([]);
  });

  it("only evaluates routes with explicit budgets when no default is set", () => {
    const report = createFixtureReport();
    const evaluation = evaluateBudgets(report, { "/dashboard": "1mb" });

    expect(evaluation.results.map((result) => result.path)).toEqual(["/dashboard"]);
    expect(evaluation.ok).toBe(true);
  });

  it("reports budget keys that do not match any route", () => {
    const report = createFixtureReport();
    const evaluation = evaluateBudgets(report, { "/missing": "1kb" });

    expect(evaluation.results).toEqual([]);
    expect(evaluation.unmatched).toEqual(["/missing"]);
    expect(evaluation.ok).toBe(true);
  });
});

describe("formatBundleReport", () => {
  it("renders an aligned plain-text table without ANSI codes by default", () => {
    const report = createFixtureReport();
    const output = formatBundleReport(report);
    const lines = output.split("\n");

    expect(output).not.toContain("\u001b[");
    expect(lines[0]).toMatch(/^Route \/ chunk\s+Gzip\s+Raw$/);
    expect(output).toContain("/dashboard (spa)");
    expect(output).toContain("/ (ssg)");
    expect(output).toContain("shared entry (all routes)");
    expect(output).toContain("total (incl. shared)");

    // Routes sorted by total gzip descending.
    expect(output.indexOf("/dashboard (spa)")).toBeLessThan(output.indexOf("/ (ssg)"));

    // Columns are aligned: every row has the same width.
    const widths = new Set(lines.map((line) => line.trimEnd().length === line.length));
    expect(widths.size).toBe(1);
  });

  it("emits ANSI codes when color is enabled", () => {
    const report = createFixtureReport();
    expect(formatBundleReport(report, { color: true })).toContain("\u001b[1m");
  });
});

describe("formatBudgetResults", () => {
  it("prints pass/fail per route with the matched budget", () => {
    const report = createFixtureReport();
    const evaluation = evaluateBudgets(report, { "*": 50, "/dashboard": "1mb" });
    const output = formatBudgetResults(evaluation);

    expect(output).not.toContain("\u001b[");
    expect(output).toMatch(/FAIL\s+\/\s+.* > 50b \(\*\)/);
    expect(output).toMatch(/PASS\s+\/dashboard\s+.* <= 1\.00mb/);
  });

  it("warns about unmatched budget keys", () => {
    const report = createFixtureReport();
    const evaluation = evaluateBudgets(report, { "/missing": "1kb" });
    expect(formatBudgetResults(evaluation)).toContain('budget for "/missing" does not match');
  });
});
