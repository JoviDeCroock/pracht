import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// Coverage for the env safety feature — builds a copy of examples/basic with a
// route component that references a non-public env var and asserts the client
// build fails naming the variable, then that the envSafety allowlist escape
// hatch lets the same build pass.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

const LEAKED_ENV_VAR = "PRACHT_E2E_SECRET_TOKEN";

function prepareLeakyProject(): { tempDir: string; exampleDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-env-safety-"));
  const exampleDir = resolve(tempDir, "project");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/basic/${entry}`),
      );
    },
    recursive: true,
  });

  writeFileSync(
    resolve(exampleDir, "src/routes/env-leak.tsx"),
    [
      `export function Component() {`,
      `  return <p>{process.env.${LEAKED_ENV_VAR}}</p>;`,
      `}`,
      ``,
    ].join("\n"),
    "utf-8",
  );

  const routesPath = resolve(exampleDir, "src/routes.ts");
  const routesSource = readFileSync(routesPath, "utf-8");
  writeFileSync(
    routesPath,
    routesSource.replace(
      'route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),',
      `route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),\n      route("/env-leak", () => import("./routes/env-leak.tsx"), { id: "env-leak", render: "ssr" }),`,
    ),
    "utf-8",
  );

  return { tempDir, exampleDir };
}

function runBuild(exampleDir: string): void {
  execFileSync(process.execPath, [cliEntry, "build"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-strip-types",
      PRACHT_ADAPTER: "node",
    },
    stdio: "pipe",
  });
}

test("client builds fail when a chunk references a non-public env var", async () => {
  test.setTimeout(120_000);

  const { tempDir, exampleDir } = prepareLeakyProject();

  try {
    let failure: Error & { stderr?: Buffer } = new Error("build unexpectedly succeeded");
    try {
      runBuild(exampleDir);
    } catch (error) {
      failure = error as Error & { stderr?: Buffer };
    }

    const output = `${failure.message}\n${failure.stderr?.toString() ?? ""}`;
    expect(output).toContain("Environment variable leak detected");
    expect(output).toContain(`process.env.${LEAKED_ENV_VAR}`);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("envSafety allowlist lets an intentional env reference through", async () => {
  test.setTimeout(120_000);

  const { tempDir, exampleDir } = prepareLeakyProject();

  try {
    const configPath = resolve(exampleDir, "vite.config.ts");
    const configSource = readFileSync(configPath, "utf-8");
    writeFileSync(
      configPath,
      configSource.replace(
        "adapter: await resolveAdapter(),",
        `adapter: await resolveAdapter(),\n      envSafety: { allow: [${JSON.stringify(LEAKED_ENV_VAR)}] },`,
      ),
      "utf-8",
    );

    expect(() => runBuild(exampleDir)).not.toThrow();
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
