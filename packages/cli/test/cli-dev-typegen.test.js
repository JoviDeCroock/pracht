import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  cliPath,
  createRepoTempDir,
  runCli,
  stopChild,
  waitFor,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli dev typegen", () => {
  it("pracht dev explains how to enable generated route types", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-hint-");
    writeTypedManifestApp(appDir);

    const child = spawn(process.execPath, [cliPath, "dev"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("run `pracht typegen` once"),
        30_000,
        () => output,
      );
      expect(existsSync(join(appDir, "src/pracht.d.ts"))).toBe(false);
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev keeps generated route types in sync with route files", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-");
    writeTypedManifestApp(appDir);
    writeProjectFile(
      appDir,
      "src/routes.ts",
      `import { defineApp } from "@pracht/core";
import { routes } from "./route-definitions";

export const app = defineApp({ routes });
`,
    );
    writeProjectFile(
      appDir,
      "src/route-definitions.ts",
      `import { route } from "@pracht/core";

export const routes = [
  route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
];
`,
    );
    runCli(["typegen"], { cwd: appDir });

    const child = spawn(process.execPath, [cliPath, "dev"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      // The route-type watcher attaches before the banner prints.
      await waitFor(
        () => output.includes("http"),
        30_000,
        () => output,
      );

      writeProjectFile(
        appDir,
        "src/api/ping.ts",
        "export function GET() {\n  return Response.json({ pong: true });\n}\n",
      );

      await waitFor(
        () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8").includes('"/api/ping"'),
        30_000,
        () => output,
      );

      writeProjectFile(
        appDir,
        "src/route-definitions.ts",
        `import { route } from "@pracht/core";

export const routes = [
  route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
  route("/settings", "./routes/home.tsx", { id: "settings", render: "ssr" }),
];
`,
      );

      await waitFor(
        () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8").includes('"settings"'),
        30_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 120_000);
});
