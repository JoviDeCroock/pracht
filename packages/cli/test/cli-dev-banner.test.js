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
  it("pracht dev prints the banner again after a manifest edit restarts the server", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-banner-restart-");
    writeTypedManifestApp(appDir);
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
    } finally {
      await stopChild(child);
    }
  }, 120_000);
});
