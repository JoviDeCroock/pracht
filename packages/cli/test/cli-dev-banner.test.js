import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  cliPath,
  createRepoTempDir,
  stopChild,
  waitFor,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli dev banner", () => {
  it("pracht dev prints the banner again after a manifest edit", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-banner-restart-");
    writeTypedManifestApp(appDir, { capabilities: true });
    // The banner reads capabilities from source, on startup and on restart.
    const capabilityPath = join(appDir, "src/capabilities/notes-search.ts");
    writeProjectFile(
      appDir,
      "src/capabilities/notes-search.ts",
      `console.log("CAPABILITY_MODULE_EXECUTED");\n${readFileSync(capabilityPath, "utf-8")}`,
    );
    const manifestPath = join(appDir, "src/routes.ts");
    const manifest = readFileSync(manifestPath, "utf-8");
    expect(manifest).toContain("  routes: [\n");
    const routeCount = (text) => [...text.matchAll(/Routes \((\d+)\)/g)].map((match) => match[1]);

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "5613"], {
      cwd: appDir,
      env: { ...process.env, NO_COLOR: "1" },
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
    const plain = () => stripVTControlCharacters(output);

    try {
      await waitFor(
        () => routeCount(plain()).length === 1,
        30_000,
        () => output,
      );
      const [initial] = routeCount(plain());

      writeProjectFile(
        appDir,
        "src/routes.ts",
        manifest.replace(
          "  routes: [\n",
          '  routes: [\n    route("/added", "./routes/home.tsx", { id: "added", render: "ssr" }),\n',
        ),
      );
      await waitFor(
        () => routeCount(plain()).length >= 2,
        60_000,
        () => output,
      );

      expect(routeCount(plain()).at(-1)).toBe(String(Number(initial) + 1));
      expect(plain().split("Routes (").at(-1)).toContain("/added");
      expect(plain().split("Routes (").at(-1)).toContain("notes.search");
      expect(output).not.toContain("CAPABILITY_MODULE_EXECUTED");
      // The edit is applied in place, so this banner is not a restart's.
      expect(plain()).not.toContain("server restarted");
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev prints the banner once a manifest that failed at startup is fixed", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-banner-recover-");
    writeTypedManifestApp(appDir);
    const manifestPath = join(appDir, "src/routes.ts");
    const manifest = readFileSync(manifestPath, "utf-8");
    writeProjectFile(appDir, "src/routes.ts", `throw new Error("broken manifest");\n${manifest}`);

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "5614"], {
      cwd: appDir,
      env: { ...process.env, NO_COLOR: "1" },
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
        () => output.includes("http://"),
        30_000,
        () => output,
      );
      expect(output).not.toContain("Routes (");

      writeProjectFile(appDir, "src/routes.ts", manifest);
      await waitFor(
        () => stripVTControlCharacters(output).includes("Routes ("),
        60_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 120_000);
});
