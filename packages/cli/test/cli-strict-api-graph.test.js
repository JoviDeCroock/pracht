import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { cliPath, repoRoot } from "./helpers/cli-fixtures.js";

const fixture = resolve(repoRoot, "packages/cli/test/fixtures/api-runtime-failure");

describe("@pracht/cli strict API graph loading", () => {
  it.each([
    ["inspect api", ["inspect", "api", "--json"]],
    ["inspect all", ["inspect", "all", "--json"]],
    ["plan", ["plan", "--json"]],
    ["verify", ["verify", "--json"]],
  ])(
    "makes %s fail closed with the route, file, and original error",
    (_, args) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: fixture,
        encoding: "utf-8",
        env: process.env,
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      const output = `${result.stderr}\n${result.stdout}`.replaceAll('\\"', '"');
      expect(output).toContain('API route "/api/broken"');
      expect(output).toContain('from "/src/api/broken.js"');
      expect(output).toContain("API fixture initialization exploded");
    },
    25_000,
  );
});
