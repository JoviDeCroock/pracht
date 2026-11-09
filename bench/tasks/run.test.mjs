import { access, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readMetrics, runTrial, summarize, validateConfig } from "./run.mjs";

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pracht-bench-test-"));
  dirs.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "state.txt"), "broken");
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Benchmark fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const check = [
    process.execPath,
    "-e",
    "process.exit(require('node:fs').readFileSync('state.txt','utf8') === 'fixed' ? 0 : 1)",
  ];
  const agent = [
    process.execPath,
    "-e",
    "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{if(!s.includes('Diagnose'))process.exit(2);require('node:fs').writeFileSync('state.txt','fixed');require('node:fs').writeFileSync(process.env.PRACHT_TASK_METRICS_FILE,JSON.stringify({toolCalls:2,repairCycles:1}));})",
  ];
  return {
    root,
    source,
    config: {
      framework: "fixture",
      frameworkVersion: "1.0.0",
      source,
      revision: git("rev-parse", "HEAD"),
      agent: { name: "fixture", version: "1", model: "deterministic-test", command: agent },
      setup: [],
      tasks: {
        "repair-loader": {
          checks: {
            "detail-repaired": check,
            "auth-preserved": check,
            "exposure-preserved": check,
          },
        },
      },
    },
  };
}

describe("task benchmark", () => {
  it("requires pinned metadata and every acceptance criterion", async () => {
    const { config } = await fixture();
    expect(validateConfig(config)).toBe(config);
    expect(() => validateConfig({ ...config, revision: "main" })).toThrow("pinned");
    const incomplete = structuredClone(config);
    delete incomplete.tasks["repair-loader"].checks["auth-preserved"];
    expect(() => validateConfig(incomplete)).toThrow("auth-preserved");
    expect(() =>
      validateConfig({ ...config, agent: { ...config.agent, command: "agent --run" } }),
    ).toThrow("argv");
  });

  it("runs each trial from the pinned source and verifies resulting state", async () => {
    const { root, source, config } = await fixture();
    let configurationHash;
    for (let trial = 1; trial <= 2; trial++) {
      const out = join(root, `out-${trial}`);
      const orderedConfig =
        trial === 1 ? config : Object.fromEntries(Object.entries(config).reverse());
      const result = await runTrial(orderedConfig, "repair-loader", {
        out,
        trial,
        timeoutMs: 5000,
      });
      if (trial === 1) configurationHash = result.configurationSha256;
      expect(result.configurationSha256).toBe(configurationHash);
      expect(result.success).toBe(true);
      expect(result.checks).toHaveLength(3);
      expect(result.metrics.toolCalls).toBe(2);
      expect(result.metrics.interventions).toBe(null);
      expect(JSON.parse(await readFile(join(out, "result.json"), "utf8")).revision).toBe(
        config.revision,
      );
    }
    expect(await readFile(join(source, "state.txt"), "utf8")).toBe("broken");
  });

  it("runs the CLI and preserves prior trial artifacts", async () => {
    const { root, config } = await fixture();
    const configFile = join(root, "config.json");
    const out = join(root, "cli");
    await writeFile(configFile, JSON.stringify(config));
    const runner = new URL("./run.mjs", import.meta.url);
    execFileSync(process.execPath, [
      runner.pathname,
      "--config",
      configFile,
      "--task",
      "repair-loader",
      "--repeats",
      "1",
      "--out",
      out,
    ]);
    const report = JSON.parse(await readFile(join(out, "summary.json"), "utf8"));
    expect(report[0].passed).toBe(1);
    expect(report[0].suiteSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(runTrial(config, "repair-loader", { out: join(out, "1") })).rejects.toThrow();
  });

  it("does not credit a successful agent command when acceptance checks fail", async () => {
    const { root, config } = await fixture();
    config.agent.command = [process.execPath, "-e", "process.exit(0)"];
    const result = await runTrial(config, "repair-loader", {
      out: join(root, "out"),
      timeoutMs: 5000,
    });
    expect(result.agentResult.ok).toBe(true);
    expect(result.success).toBe(false);
    expect(result.checks.every((check) => !check.ok)).toBe(true);
    expect(result.metrics.toolCalls).toBe(null);
  });

  it("stops inherited background processes when the agent command exits", async () => {
    if (process.platform === "win32") return;
    const { root, config } = await fixture();
    config.agent.command = [
      process.execPath,
      "-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});c.unref()",
    ];
    const result = await runTrial(config, "repair-loader", {
      out: join(root, "out"),
      timeoutMs: 5000,
    });
    expect(result.agentResult.exitCode).toBe(0);
    expect(result.agentResult.timedOut).toBe(false);
  });

  it("cleans up the disposable checkout even if result persistence fails", async () => {
    const { root, config } = await fixture();
    const marker = join(root, "workspace.txt");
    config.agent.command = [
      process.execPath,
      "-e",
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},process.env.PRACHT_TASK_WORKSPACE);fs.rmSync(require('node:path').dirname(process.env.PRACHT_TASK_METRICS_FILE),{recursive:true,force:true});`,
    ];
    await expect(
      runTrial(config, "repair-loader", { out: join(root, "out"), timeoutMs: 5000 }),
    ).rejects.toThrow();
    const workspace = await readFile(marker, "utf8");
    await expect(access(workspace)).rejects.toThrow();
  });

  it("records setup failure and never runs the agent", async () => {
    const { root, config } = await fixture();
    config.setup = [[process.execPath, "-e", "process.exit(3)"]];
    const result = await runTrial(config, "repair-loader", {
      out: join(root, "out"),
      timeoutMs: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.phase).toBe("setup");
    expect(result.agentResult).toBeUndefined();
    expect(result.setupError.exitCode).toBe(3);
  });

  it("bounds execution time and rejects invalid metrics without inventing zeros", async () => {
    const { root, config } = await fixture();
    config.agent.command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
    const result = await runTrial(config, "repair-loader", {
      out: join(root, "out"),
      timeoutMs: 1500,
    });
    expect(result.success).toBe(false);
    expect(result.agentResult.timedOut).toBe(true);
    expect(readMetrics({})).toEqual({
      interventions: null,
      toolCalls: null,
      inputTokens: null,
      outputTokens: null,
      repairCycles: null,
    });
    expect(() => readMetrics({ inputTokens: -1 })).toThrow("inputTokens");
    expect(() => readMetrics({ toolCalls: "2" })).toThrow("toolCalls");
  });

  it("keeps versions separate and reports metric observation counts", () => {
    const record = {
      framework: "fixture",
      frameworkVersion: "1",
      revision: "a",
      configurationSha256: "config-a",
      agent: { name: "agent", version: "1", model: "model" },
      task: "repair-loader",
      success: true,
      agentDurationMs: 10,
      metrics: readMetrics({ toolCalls: 2 }),
    };
    const report = summarize([
      record,
      { ...record, success: false, agentDurationMs: 20, metrics: readMetrics({}) },
      { ...record, frameworkVersion: "2" },
      { ...record, configurationSha256: "config-b" },
    ]);
    expect(report).toHaveLength(3);
    expect(report[0].successRate).toBe(0.5);
    expect(report[0].medianAgentDurationMs).toBe(15);
    expect(report[0].metrics.toolCalls).toEqual({ median: 2, observed: 1 });
    expect(report[0].metrics.interventions).toEqual({ median: null, observed: 0 });
  });
});
