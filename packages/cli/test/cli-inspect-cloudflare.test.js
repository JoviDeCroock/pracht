import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { cliPath, repoRoot } from "./helpers/cli-fixtures.js";

describe("@pracht/cli inspect with Cloudflare", () => {
  it.each([
    ["inspect build", ["inspect", "build", "--json"]],
    ["plan", ["plan", "--json"]],
  ])(
    "prints %s output and exits without starting the Worker runtime",
    (_, args) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: resolve(repoRoot, "examples/cloudflare"),
        encoding: "utf-8",
        env: process.env,
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode ?? report.live?.mode).toBe("manifest");
    },
    25_000,
  );

  it("loads capability contracts that import cloudflare:workers and exits", () => {
    const result = spawnSync(process.execPath, [cliPath, "inspect", "capabilities", "--json"], {
      cwd: resolve(repoRoot, "packages/cli/test/fixtures/cloudflare-runtime-import"),
      encoding: "utf-8",
      env: process.env,
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.capabilities).toMatchObject([
      {
        effect: "read",
        name: "edge.runtime",
        title: "Cloudflare runtime import",
        transports: ["http"],
      },
    ]);
  }, 25_000);

  it.each([
    [
      "inspect",
      ["inspect", "capabilities", "--json"],
      "unknown-module",
      /cloudflare:future-runtime/,
    ],
    ["plan", ["plan", "--json"], "helper-call", /cloudflare:workers waitUntil/],
    ["typegen", ["typegen", "--check", "--json"], "unknown-module", /cloudflare:future-runtime/],
    [
      "binding reflection",
      ["inspect", "capabilities", "--json"],
      "binding-reflection",
      /cloudflare:workers env property enumeration is unavailable during graph inspection/,
    ],
    [
      "binding property read",
      ["inspect", "capabilities", "--json"],
      "binding-read",
      /cloudflare:workers env property DB access is unavailable during graph inspection/,
    ],
    [
      "RpcTarget construction",
      ["inspect", "capabilities", "--json"],
      "constructor-rpc-target",
      /cloudflare:workers RpcTarget is unavailable during graph inspection/,
    ],
    [
      "EmailMessage construction",
      ["inspect", "capabilities", "--json"],
      "constructor-email-message",
      /cloudflare:email EmailMessage is unavailable during graph inspection/,
    ],
    [
      "WorkflowEntrypoint construction",
      ["inspect", "capabilities", "--json"],
      "constructor-workflow-entrypoint",
      /cloudflare:workflows WorkflowEntrypoint is unavailable during graph inspection/,
    ],
    ["verify", ["verify", "--json"], "unknown-module", /cloudflare:future-runtime/],
  ])(
    "makes %s fail closed when a capability cannot load",
    (_, args, failure, message) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: resolve(repoRoot, "packages/cli/test/fixtures/cloudflare-runtime-import"),
        encoding: "utf-8",
        env: { ...process.env, PRACHT_GRAPH_FAILURE: failure },
        timeout: 15_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(message);
    },
    25_000,
  );
});
