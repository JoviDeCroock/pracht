import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot, runCli, runCliStatus } from "./helpers/cli-fixtures.js";
import { removeTempDir } from "./helpers/remove-temp-dir.ts";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir);
});

const frameworkDir = resolve(repoRoot, "packages/framework");
const frameworkVersion = JSON.parse(
  readFileSync(join(frameworkDir, "package.json"), "utf-8"),
).version;

/**
 * Installs the *published* `@pracht/core` deprecations artifacts — the real
 * manifest and the real codemod — into a fixture's node_modules, so this
 * exercises what ships rather than a synthetic stand-in.
 *
 * The fixture lives in the OS temp dir on purpose: the CLI walks parent
 * directories for `node_modules/@pracht/*` the way Node resolution does, and a
 * fixture under packages/ would resolve the workspace's own packages instead.
 */
function createApp(files) {
  const root = mkdtempSync(join(tmpdir(), "pracht-cli-upgrade-"));
  tempDirs.push(root);

  const corePath = join(root, "node_modules/@pracht/core");
  mkdirSync(corePath, { recursive: true });
  writeFileSync(
    join(corePath, "package.json"),
    JSON.stringify({
      name: "@pracht/core",
      version: frameworkVersion,
      pracht: { deprecations: "./deprecations.json" },
    }),
  );
  cpSync(join(frameworkDir, "deprecations.json"), join(corePath, "deprecations.json"));
  cpSync(join(frameworkDir, "codemods"), join(corePath, "codemods"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      dependencies: { "@pracht/core": `^${frameworkVersion}` },
    }),
  );
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf-8");
  }
  return root;
}

describe("pracht upgrade", () => {
  it("reports a removed API with its call sites and fails --check", () => {
    const appDir = createApp({
      "src/routes/dashboard.tsx": [
        'import { useRevalidateRoute } from "@pracht/core";',
        "",
        "export default function Dashboard() {",
        "  const revalidate = useRevalidateRoute();",
        "  return <button onClick={revalidate}>Refresh</button>;",
        "}",
      ].join("\n"),
    });

    const report = JSON.parse(runCli(["upgrade", "--json"], { cwd: appDir }).stdout);
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: "core.use-revalidate-route",
      package: "@pracht/core",
      severity: "error",
      removedIn: "0.2.7",
      codemod: true,
    });
    expect(report.findings[0].occurrences.map((entry) => entry.line)).toEqual([1, 4]);

    const text = runCli(["upgrade"], { cwd: appDir }).stdout;
    expect(text).toContain("REMOVED  core.use-revalidate-route");
    expect(text).toContain("src/routes/dashboard.tsx:4");
    expect(text).toContain("pracht upgrade --fix");

    // The plain report is advisory; only --check turns it into a gate.
    expect(runCliStatus(["upgrade"], { cwd: appDir }).status).toBe(0);
    expect(runCliStatus(["upgrade", "--check"], { cwd: appDir }).status).toBe(1);
  }, 60_000);

  it("applies the published codemod and leaves the app clean", () => {
    const appDir = createApp({
      "src/app.tsx":
        'import { useRevalidate, useRevalidateRoute } from "@pracht/core";\n' +
        "export const refresh = useRevalidateRoute;\n" +
        "export const other = useRevalidate;\n",
    });

    const output = runCli(["upgrade", "--fix"], { cwd: appDir }).stdout;
    expect(output).toContain("updated  src/app.tsx");
    expect(output).toContain("No deprecated or removed APIs are in use.");

    // The rename must not leave a duplicate specifier behind in a file that
    // already imported the replacement.
    expect(readFileSync(join(appDir, "src/app.tsx"), "utf-8")).toBe(
      'import { useRevalidate } from "@pracht/core";\n' +
        "export const refresh = useRevalidate;\n" +
        "export const other = useRevalidate;\n",
    );
    expect(runCliStatus(["upgrade", "--check"], { cwd: appDir }).status).toBe(0);
  }, 60_000);

  it("says nothing is in use for an app on current APIs", () => {
    const appDir = createApp({
      "src/app.tsx":
        'import { useRevalidate } from "@pracht/core";\nexport const r = useRevalidate;',
    });

    const output = runCli(["upgrade"], { cwd: appDir }).stdout;
    expect(output).toContain("No deprecated or removed APIs are in use.");
    expect(output).toContain(`@pracht/core  ${frameworkVersion}`);
    expect(output).toContain("npm install @pracht/core@latest");
  }, 60_000);
});
