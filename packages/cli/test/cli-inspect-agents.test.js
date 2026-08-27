import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readBuildLlmsTxtEnabled, resolveBuildLlmsTxtEnabled } from "../src/app-server.ts";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCli,
  runCliStatus,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli inspect agents", () => {
  it("does not report llms.txt as disabled when an older plugin omits the metadata flag", () => {
    expect(readBuildLlmsTxtEnabled([{ name: "pracht" }])).toBeNull();
    expect(readBuildLlmsTxtEnabled([{ name: "pracht", api: { llmsTxtEnabled: true } }])).toBe(true);
  });

  it("summarizes the configured agent surface as JSON", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-");
    writeTypedManifestApp(appDir, { capabilities: true, agents: true });

    const { agents } = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);

    expect(agents.webBotAuth).toEqual({
      enabled: true,
      policy: "require",
      staticKeys: 1,
      directories: ["https://signature-agent.example"],
    });
    expect(agents.confirmation).toEqual({ mode: "token", ttlSeconds: 300, singleUse: true });
    expect(agents.mcp).toEqual({ enabled: true, endpoint: "/mcp" });
    expect(agents.llmsTxt).toEqual({ enabled: true });

    // One capability per manifest entry, with the transports it is exposed on.
    expect(agents.capabilities).toEqual([
      {
        name: "notes.search",
        effect: "read",
        agentPolicy: null,
        transports: ["http", "mcp", "webmcp"],
        httpPath: "/api/capabilities/notes/search",
      },
      {
        name: "notes.set-status",
        effect: "write",
        agentPolicy: null,
        transports: [],
        httpPath: null,
      },
      {
        name: "notes.purge",
        effect: "destructive",
        agentPolicy: null,
        transports: ["http"],
        httpPath: "/api/capabilities/notes/purge",
      },
      {
        name: "notes.stats",
        effect: "read",
        agentPolicy: null,
        transports: ["http"],
        httpPath: "/api/capabilities/notes/stats",
      },
    ]);

    // `private` counts capabilities reachable only through invokeCapability().
    expect(agents.exposure).toEqual({ http: 3, webmcp: 1, mcp: 1, private: 1 });
  }, 30_000);

  it("prints a readable agent surface summary", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-text-");
    writeTypedManifestApp(appDir, { capabilities: true, agents: true });

    const { stdout } = runCli(["inspect", "agents"], { cwd: appDir });

    expect(stdout).toContain("\nAgents");
    expect(stdout).toContain("webBotAuth=on  policy=require  keys=1");
    expect(stdout).toContain("confirmation=token  ttlSeconds=300  singleUse=true");
    expect(stdout).toContain("mcp=on  endpoint=/mcp");
    expect(stdout).toContain("llmsTxt=on");
    expect(stdout).toContain("exposure  http=3  webmcp=1  mcp=1  private=1");
    expect(stdout).toContain("notes.search  effect=read  transports=http,mcp,webmcp");
    // A capability with no override inherits the app-wide policy — say so
    // rather than printing a bare "null".
    expect(stdout).toContain("policy=require (inherited)");
    expect(stdout).toContain("notes.set-status  effect=write  transports=private");
  }, 30_000);

  it("reads llms.txt state from the resolved plugin options", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-llms-");
    writeTypedManifestApp(appDir, { capabilities: true, agents: true });
    const configPath = resolve(appDir, "vite.config.ts");
    writeProjectFile(
      appDir,
      "vite.config.ts",
      readFileSync(configPath, "utf-8").replace(
        'pracht({ llmsTxt: { title: "Fixture app" } })',
        "pracht({ llmsTxt: undefined })",
      ),
    );

    const { agents } = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);

    expect(agents.llmsTxt).toEqual({ enabled: false });
  }, 30_000);

  it("reads llms.txt state from the production server-build configuration", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-build-llms-");
    writeTypedManifestApp(appDir, { capabilities: true, agents: true });
    const configPath = resolve(appDir, "vite.config.ts");
    const source = readFileSync(configPath, "utf-8")
      .replace(
        "export default defineConfig({",
        "export default defineConfig(({ command, isSsrBuild, mode }) => ({",
      )
      .replace(
        'pracht({ llmsTxt: { title: "Fixture app" } })',
        'pracht({ llmsTxt: command === "build" && isSsrBuild && mode === "production" ? { title: "Fixture app" } : false })',
      )
      .replace("\n});\n", "\n}));\n");
    writeProjectFile(appDir, "vite.config.ts", source);

    const { agents } = JSON.parse(runCli(["inspect", "agents", "--json"], { cwd: appDir }).stdout);

    expect(agents.llmsTxt).toEqual({ enabled: true });
  }, 30_000);

  it("uses Vite's production NODE_ENV without leaking it into later inspection", async () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-node-env-");
    writeTypedManifestApp(appDir, { capabilities: true, agents: true });
    const configPath = resolve(appDir, "vite.config.ts");
    writeProjectFile(
      appDir,
      "vite.config.ts",
      readFileSync(configPath, "utf-8").replace(
        'pracht({ llmsTxt: { title: "Fixture app" } })',
        'pracht({ llmsTxt: process.env.NODE_ENV === "production" ? { title: "Fixture app" } : false })',
      ),
    );

    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(await resolveBuildLlmsTxtEnabled(appDir)).toBe(true);
      expect(process.env.NODE_ENV).toBeUndefined();
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  }, 30_000);

  it("does not erase other agent surfaces when no capabilities are registered", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-empty-capabilities-");
    writeTypedManifestApp(appDir, { agents: true });

    const { stdout } = runCli(["inspect", "agents"], { cwd: appDir });

    expect(stdout).toContain("webBotAuth=on");
    expect(stdout).toContain("mcp=on  endpoint=/mcp");
    expect(stdout).toContain("llmsTxt=on");
    expect(stdout).toContain("No capability operations registered.");
    expect(stdout).not.toContain("this app exposes no agent surface");
  }, 30_000);

  it("rejects an unknown target and lists the valid ones", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-agents-unknown-");
    writeTypedManifestApp(appDir, { capabilities: true });

    const { status, stderr } = runCliStatus(["inspect", "agent"], { cwd: appDir });

    expect(status).toBe(1);
    expect(stderr).toContain("agents");
  }, 30_000);
});
