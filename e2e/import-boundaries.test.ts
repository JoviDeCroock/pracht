import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

function prepareProject(): { exampleDir: string; tempDir: string } {
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-import-boundaries-"));
  const exampleDir = resolve(tempDir, "project");
  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/basic/${entry}`),
      );
    },
    recursive: true,
  });
  return { exampleDir, tempDir };
}

function addRoute(exampleDir: string, name: string, source: string): void {
  writeFileSync(resolve(exampleDir, `src/routes/${name}.tsx`), source, "utf-8");
  const routesPath = resolve(exampleDir, "src/routes.ts");
  const routesSource = readFileSync(routesPath, "utf-8");
  writeFileSync(
    routesPath,
    routesSource.replace(
      'route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),',
      `route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),\n      route("/${name}", () => import("./routes/${name}.tsx"), { id: "${name}", render: "ssr" }),`,
    ),
    "utf-8",
  );
}

function buildFailure(exampleDir: string): string {
  try {
    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-strip-types",
        PRACHT_ADAPTER: "node",
      },
      stdio: "pipe",
    });
    return "build unexpectedly succeeded";
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer; stdout?: Buffer };
    return `${failure.message}\n${failure.stdout?.toString() ?? ""}\n${failure.stderr?.toString() ?? ""}`;
  }
}

test("client graphs reject .server modules", async () => {
  test.setTimeout(120_000);
  const { exampleDir, tempDir } = prepareProject();

  try {
    writeFileSync(
      resolve(exampleDir, "src/session.server.ts"),
      'export const sessionSecret = "private";\n',
      "utf-8",
    );
    addRoute(
      exampleDir,
      "boundary-client",
      [
        'import { sessionSecret } from "../session.server.ts";',
        "export function Component() {",
        "  return <main>{sessionSecret}</main>;",
        "}",
        "",
      ].join("\n"),
    );

    expect(buildFailure(exampleDir)).toMatch(
      /Import boundary violation.*server-only.*client graph/,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("server graphs reject .client modules", async () => {
  test.setTimeout(120_000);
  const { exampleDir, tempDir } = prepareProject();

  try {
    writeFileSync(
      resolve(exampleDir, "src/browser.client.ts"),
      'export const browserValue = "browser";\n',
      "utf-8",
    );
    addRoute(
      exampleDir,
      "boundary-server",
      [
        'import { browserValue } from "../browser.client.ts";',
        "export async function loader() {",
        "  return { browserValue };",
        "}",
        "export function Component() {",
        "  return <main>Boundary</main>;",
        "}",
        "",
      ].join("\n"),
    );

    expect(buildFailure(exampleDir)).toMatch(
      /Import boundary violation.*client-only.*server graph/,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
