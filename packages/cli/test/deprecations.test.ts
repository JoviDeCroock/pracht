import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCodemods,
  buildUpgradeReport,
  compareVersions,
  globToRegExp,
  parseDeprecationManifest,
  type DeprecationRecord,
} from "../src/deprecations.js";
import { removeTempDir } from "./helpers/remove-temp-dir.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

// Deliberately outside the repo: the report walks parent directories for
// `node_modules/@pracht/*` exactly as Node resolution does, so a fixture under
// packages/ would pick up the workspace's own packages.
function createApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-deprecations-"));
  tempDirs.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf-8");
  }
  return root;
}

function installedCore(version: string, deprecations: DeprecationRecord[]): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "fixture-app",
      dependencies: { "@pracht/core": `^${version}` },
    }),
    "node_modules/@pracht/core/package.json": JSON.stringify({
      name: "@pracht/core",
      version,
      pracht: { deprecations: "./deprecations.json" },
    }),
    "node_modules/@pracht/core/deprecations.json": JSON.stringify({
      version: 1,
      package: "@pracht/core",
      deprecations,
    }),
  };
}

const RENAME_RECORD: DeprecationRecord = {
  id: "core.use-revalidate-route",
  title: "useRevalidateRoute() was replaced by useRevalidate()",
  since: "0.0.1",
  removedIn: "0.2.7",
  replacement: "useRevalidate()",
  detect: { include: ["src/**/*.{ts,tsx}"], pattern: "\\buseRevalidateRoute\\b" },
};

describe("compareVersions", () => {
  it("orders releases and sorts a prerelease before its release", () => {
    expect(compareVersions("0.16.0", "0.2.7")).toBeGreaterThan(0);
    expect(compareVersions("0.2.7", "0.16.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("returns null rather than guessing when a side is not plain semver", () => {
    expect(compareVersions("workspace:*", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "next")).toBeNull();
  });
});

describe("globToRegExp", () => {
  it("matches nested paths, brace alternatives, and root-level config files", () => {
    const source = globToRegExp("src/**/*.{ts,tsx}");
    expect(source.test("src/app.ts")).toBe(true);
    expect(source.test("src/routes/nested/page.tsx")).toBe(true);
    expect(source.test("src/app.js")).toBe(false);
    expect(source.test("other/app.ts")).toBe(false);

    const config = globToRegExp("*.config.{ts,js}");
    expect(config.test("vite.config.ts")).toBe(true);
    // A single `*` must not cross a separator, or every glob leaks into
    // subdirectories the record never named.
    expect(config.test("nested/vite.config.ts")).toBe(false);
  });
});

describe("parseDeprecationManifest", () => {
  it("keeps valid records and reports the ones it drops", () => {
    const warnings: string[] = [];
    const manifest = parseDeprecationManifest(
      {
        version: 1,
        deprecations: [
          RENAME_RECORD,
          { id: "core.no-title", since: "1.0.0" },
          { id: "core.bad-pattern", title: "x", since: "1.0.0", detect: { pattern: "([" } },
          "not an object",
        ],
      },
      "@pracht/core",
      warnings,
    );

    expect(manifest?.deprecations.map((record) => record.id)).toEqual([
      "core.use-revalidate-route",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("core.bad-pattern");
  });

  it("refuses a manifest written against a future schema version", () => {
    const warnings: string[] = [];
    expect(
      parseDeprecationManifest({ version: 2, deprecations: [] }, "@pracht/core", warnings),
    ).toBeNull();
    expect(warnings[0]).toContain("is not supported");
  });
});

describe("buildUpgradeReport", () => {
  it("reports a removed API as an error with its call sites", () => {
    const root = createApp({
      ...installedCore("0.16.0", [RENAME_RECORD]),
      "src/routes/dashboard.tsx": [
        'import { useRevalidateRoute } from "@pracht/core";',
        "",
        "export default function Dashboard() {",
        "  const revalidate = useRevalidateRoute();",
        "  return <button onClick={revalidate}>Refresh</button>;",
        "}",
      ].join("\n"),
    });

    const report = buildUpgradeReport(root);
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);

    const [finding] = report.findings;
    expect(finding.id).toBe("core.use-revalidate-route");
    // Installed 0.16.0 is past the 0.2.7 removal, so this code is broken now
    // rather than merely dated — that distinction is the whole severity axis.
    expect(finding.severity).toBe("error");
    expect(finding.installedVersion).toBe("0.16.0");
    expect(finding.occurrences).toEqual([
      {
        file: "src/routes/dashboard.tsx",
        line: 1,
        text: 'import { useRevalidateRoute } from "@pracht/core";',
      },
      {
        file: "src/routes/dashboard.tsx",
        line: 4,
        text: "const revalidate = useRevalidateRoute();",
      },
    ]);
  });

  it("downgrades to a warning when the removal is still ahead of the installed version", () => {
    const root = createApp({
      ...installedCore("0.16.0", [{ ...RENAME_RECORD, removedIn: "0.20.0" }]),
      "src/app.ts": "export const revalidate = useRevalidateRoute;",
    });

    const report = buildUpgradeReport(root);
    expect(report.findings[0].severity).toBe("warn");
    // A scheduled removal is not a broken build, so `--check` stays green.
    expect(report.ok).toBe(true);
  });

  it("ignores mentions inside comments and strings", () => {
    const root = createApp({
      ...installedCore("0.16.0", [RENAME_RECORD]),
      "src/app.ts": [
        "// TODO: we used to call useRevalidateRoute here",
        'export const note = "useRevalidateRoute was removed";',
      ].join("\n"),
    });

    expect(buildUpgradeReport(root).findings).toEqual([]);
  });

  it("skips records the installed version predates, and files outside the record's globs", () => {
    const root = createApp({
      ...installedCore("0.16.0", [
        { ...RENAME_RECORD, id: "core.future", since: "0.20.0", removedIn: "0.21.0" },
      ]),
      "src/app.ts": "useRevalidateRoute();",
      "scripts/legacy.ts": "useRevalidateRoute();",
    });
    expect(buildUpgradeReport(root).findings).toEqual([]);

    const scoped = createApp({
      ...installedCore("0.16.0", [RENAME_RECORD]),
      "scripts/legacy.ts": "useRevalidateRoute();",
    });
    expect(buildUpgradeReport(scoped).findings).toEqual([]);
  });

  it("suggests the upgrade command for the app's package manager", () => {
    const npmApp = createApp(installedCore("0.16.0", []));
    expect(buildUpgradeReport(npmApp).packageManager).toBe("npm");
    expect(buildUpgradeReport(npmApp).upgradeCommand).toBe("npm install @pracht/core@latest");

    const pnpmApp = createApp({
      ...installedCore("0.16.0", []),
      "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
    });
    expect(buildUpgradeReport(pnpmApp).upgradeCommand).toBe("pnpm up @pracht/core@latest");
  });

  it("surfaces a malformed dependency manifest as a warning instead of failing", () => {
    const root = createApp({
      "package.json": JSON.stringify({ dependencies: { "@pracht/core": "^0.16.0" } }),
      "node_modules/@pracht/core/package.json": JSON.stringify({
        name: "@pracht/core",
        version: "0.16.0",
        pracht: { deprecations: "./deprecations.json" },
      }),
      "node_modules/@pracht/core/deprecations.json": "{ not json",
    });

    const report = buildUpgradeReport(root);
    expect(report.findings).toEqual([]);
    expect(report.warnings.join("\n")).toContain("could not read deprecations manifest");
  });
});

describe("applyCodemods", () => {
  it("rewrites detected call sites and leaves a clean report behind", async () => {
    const root = createApp({
      ...installedCore("0.16.0", [
        { ...RENAME_RECORD, codemod: "./codemods/use-revalidate-route.js" },
      ]),
      "node_modules/@pracht/core/codemods/use-revalidate-route.js": [
        "export default {",
        '  id: "core.use-revalidate-route",',
        "  transform(source) {",
        '    if (!source.includes("useRevalidateRoute")) return null;',
        '    return source.replace(/\\buseRevalidateRoute\\b/g, "useRevalidate");',
        "  },",
        "};",
      ].join("\n"),
      "src/app.ts": 'import { useRevalidateRoute } from "@pracht/core";\nuseRevalidateRoute();',
    });

    const result = await applyCodemods(buildUpgradeReport(root));
    expect(result.appliedIds).toEqual(["core.use-revalidate-route"]);
    expect(result.changedFiles).toEqual(["src/app.ts"]);
    expect(readFileSync(join(root, "src/app.ts"), "utf-8")).toBe(
      'import { useRevalidate } from "@pracht/core";\nuseRevalidate();',
    );
    expect(buildUpgradeReport(root).findings).toEqual([]);
  });

  it("reports findings that have no published codemod rather than silently passing", async () => {
    const root = createApp({
      ...installedCore("0.16.0", [RENAME_RECORD]),
      "src/app.ts": "useRevalidateRoute();",
    });

    const result = await applyCodemods(buildUpgradeReport(root));
    expect(result.changedFiles).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "core.use-revalidate-route", reason: "no codemod is published for this deprecation" },
    ]);
  });

  it("refuses a codemod path that escapes the package that published it", async () => {
    const root = createApp({
      ...installedCore("0.16.0", [{ ...RENAME_RECORD, codemod: "../../../evil.js" }]),
      "src/app.ts": "useRevalidateRoute();",
      "evil.js": "export default { transform: () => { throw new Error('pwned'); } };",
    });

    const report = buildUpgradeReport(root);
    expect(report.findings[0].codemod).toBeNull();
    const result = await applyCodemods(report);
    expect(result.changedFiles).toEqual([]);
  });
});
