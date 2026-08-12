import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/pages-router");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

test("pracht build rejects overlapping artifacts before writing generated output", () => {
  test.setTimeout(120_000);
  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-artifact-collision-"));
  const projectDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, projectDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });
    const configPath = resolve(projectDir, "vite.config.ts");
    const config = readFileSync(configPath, "utf-8").replace(
      'info: { title: "Pracht Pages Example API", version: "1.0.0" },',
      'documentPath: "/llms.txt/openapi.json",\n        info: { title: "Pracht Pages Example API", version: "1.0.0" },',
    );
    writeFileSync(configPath, config, "utf-8");

    const result = spawnSync(process.execPath, [cliEntry, "build"], {
      cwd: projectDir,
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'OpenAPI artifact "llms.txt/openapi.json" overlaps llms.txt artifact "llms.txt"',
    );
    expect(existsSync(resolve(projectDir, "dist/client/llms.txt"))).toBe(false);
    expect(existsSync(resolve(projectDir, "dist/client/llms.txt/openapi.json"))).toBe(false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
