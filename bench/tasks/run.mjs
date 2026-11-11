import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suiteSource = await readFile(new URL("./tasks.json", import.meta.url), "utf8");
const suite = JSON.parse(suiteSource);
const suiteSha256 = createHash("sha256").update(suiteSource).digest("hex");
const runnerSha256 = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest("hex");
const metricNames = ["interventions", "toolCalls", "inputTokens", "outputTokens", "repairCycles"];

function command(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string") ||
    !value[0]
  ) {
    throw new Error(`${label} must be a nonempty argv array`);
  }
  return value;
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Expected a benchmark configuration");
  for (const key of ["framework", "frameworkVersion", "source", "revision"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!/^[0-9a-f]{40}$/.test(config.revision))
    throw new Error("revision must be a full pinned commit SHA");
  if (
    !config.agent ||
    ["name", "version", "model"].some(
      (key) => typeof config.agent[key] !== "string" || !config.agent[key].trim(),
    )
  ) {
    throw new Error("agent requires name, version, and model");
  }
  command(config.agent.command, "agent.command");
  if (!Array.isArray(config.setup)) throw new Error("setup must be an argv-array list");
  config.setup.forEach((entry) => command(entry, "setup command"));
  if (!config.tasks || typeof config.tasks !== "object") throw new Error("Missing task checks");
  for (const [id, fixture] of Object.entries(config.tasks)) {
    const task = suite.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (
      !fixture ||
      typeof fixture !== "object" ||
      !fixture.checks ||
      typeof fixture.checks !== "object"
    )
      throw new Error(`Missing checks for ${id}`);
    for (const criterion of task.criteria) command(fixture.checks[criterion], `${id}.${criterion}`);
    if (Object.keys(fixture.checks).some((criterion) => !task.criteria.includes(criterion)))
      throw new Error(`Unknown criterion for ${id}`);
    if (fixture.context !== undefined && typeof fixture.context !== "string")
      throw new Error(`${id}.context must be a string`);
    if (fixture.setup !== undefined) {
      if (!Array.isArray(fixture.setup)) throw new Error(`${id}.setup must be an argv-array list`);
      fixture.setup.forEach((entry) => command(entry, `${id} setup command`));
    }
  }
  if (Object.keys(config.tasks).length === 0) throw new Error("Configure at least one task");
  return config;
}

export function readMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Metrics must be an object");
  return Object.fromEntries(
    metricNames.map((name) => {
      const metric = value[name] ?? null;
      if (metric !== null && (!Number.isSafeInteger(metric) || metric < 0))
        throw new Error(`Invalid metric: ${name}`);
      return [name, metric];
    }),
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

async function execute(argv, cwd, env, timeoutMs, logPath, input = "") {
  return new Promise((settle) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    let failure = null;
    const capture = (chunk) => {
      const room = 1_000_000 - size;
      if (room > 0) {
        chunks.push(Buffer.from(chunk).subarray(0, room));
        size += Math.min(chunk.length, room);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The process group may already have exited. */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.once("exit", kill); // Close inherited pipes held by background descendants.
    child.on("error", (error) => {
      failure = error.message;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      kill(); // Also stop background servers left by the command.
      try {
        await writeFile(logPath, Buffer.concat(chunks));
        settle({
          ok: code === 0 && !timedOut && failure === null,
          exitCode: code,
          timedOut,
          error: failure,
        });
      } catch (error) {
        settle({ ok: false, exitCode: code, timedOut, error: error.message });
      }
    });
  });
}

export async function runTrial(config, taskId, options) {
  validateConfig(config);
  const task = suite.tasks.find((entry) => entry.id === taskId);
  const fixture = config.tasks[taskId];
  if (!task || !fixture) throw new Error(`Task is not configured: ${taskId}`);
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Preserve prior trial artifacts; choose a fresh output directory.
  const promptFile = join(out, "prompt.txt");
  const metricsFile = join(out, "metrics.json");
  const prompt = `${task.prompt}\n\n${fixture.context ?? ""}\n`;
  await writeFile(promptFile, prompt);
  await writeFile(join(out, "configuration.json"), `${JSON.stringify(config, null, 2)}\n`);
  const temp = await mkdtemp(join(tmpdir(), "pracht-task-"));
  const workspace = join(temp, "app");
  const env = {
    ...process.env,
    PRACHT_TASK_WORKSPACE: workspace,
    PRACHT_TASK_PROMPT_FILE: promptFile,
    PRACHT_TASK_METRICS_FILE: metricsFile,
  };
  const timeoutMs = options.timeoutMs ?? 900_000;
  const started = Date.now();
  const result = {
    version: 1,
    suiteVersion: suite.version,
    suiteSha256,
    runnerSha256,
    limits: { commandTimeoutMs: timeoutMs },
    configurationSha256: createHash("sha256")
      .update(JSON.stringify(canonical({ config, commandTimeoutMs: timeoutMs })))
      .digest("hex"),
    task: task.id,
    audience: task.audience,
    trial: options.trial ?? 1,
    framework: config.framework,
    frameworkVersion: config.frameworkVersion,
    revision: config.revision,
    agent: {
      name: config.agent.name,
      version: config.agent.version,
      model: config.agent.model,
      command: config.agent.command,
    },
    harness: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: new Date(started).toISOString(),
    success: false,
    phase: "setup",
    checks: [],
    metrics: readMetrics({}),
    metricError: null,
  };
  try {
    const source = resolve(options.configDir ?? process.cwd(), config.source);
    const commands = [
      ["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", source, workspace],
      ["git", "-C", workspace, "checkout", "--quiet", "--detach", config.revision],
      ...config.setup,
      ...(fixture.setup ?? []),
    ];
    for (const [index, argv] of commands.entries()) {
      const step = await execute(
        argv,
        index === 0 ? temp : workspace,
        env,
        timeoutMs,
        join(out, `setup-${index}.log`),
      );
      if (!step.ok) {
        result.setupError = step;
        return result;
      }
    }
    result.phase = "agent";
    const agentStarted = Date.now();
    result.agentResult = await execute(
      config.agent.command,
      workspace,
      env,
      timeoutMs,
      join(out, "agent.log"),
      prompt,
    );
    result.agentDurationMs = Date.now() - agentStarted;
    result.phase = "checks";
    for (const [index, criterion] of task.criteria.entries()) {
      const check = await execute(
        fixture.checks[criterion],
        workspace,
        env,
        timeoutMs,
        join(out, `check-${index}.log`),
      );
      result.checks.push({ criterion, ...check });
    }
    try {
      result.metrics = readMetrics(JSON.parse(await readFile(metricsFile, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") result.metricError = error.message;
    }
    result.success = result.agentResult.ok && result.checks.every((check) => check.ok);
    result.phase = "complete";
    return result;
  } finally {
    result.durationMs = Date.now() - started;
    try {
      await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

export function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const key = JSON.stringify([
      result.suiteSha256,
      result.runnerSha256,
      result.configurationSha256,
      result.harness,
      result.framework,
      result.frameworkVersion,
      result.revision,
      result.agent.name,
      result.agent.version,
      result.agent.model,
      result.agent.command,
      result.task,
    ]);
    const group = groups.get(key) ?? {
      suiteSha256: result.suiteSha256,
      runnerSha256: result.runnerSha256,
      limits: result.limits,
      configurationSha256: result.configurationSha256,
      harness: result.harness,
      framework: result.framework,
      frameworkVersion: result.frameworkVersion,
      revision: result.revision,
      agent: result.agent,
      task: result.task,
      trials: 0,
      passed: 0,
      durations: [],
      metrics: Object.fromEntries(metricNames.map((name) => [name, []])),
    };
    group.trials++;
    if (result.success) group.passed++;
    if (typeof result.agentDurationMs === "number") group.durations.push(result.agentDurationMs);
    for (const name of metricNames)
      if (result.metrics[name] !== null) group.metrics[name].push(result.metrics[name]);
    groups.set(key, group);
  }
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return [...groups.values()].map(({ durations, metrics, ...group }) => ({
    ...group,
    successRate: group.passed / group.trials,
    medianAgentDurationMs: median(durations),
    metrics: Object.fromEntries(
      metricNames.map((name) => [
        name,
        { median: median(metrics[name]), observed: metrics[name].length },
      ]),
    ),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify(suite, null, 2));
    return;
  }
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--config", "--task", "--repeats", "--out", "--timeout-ms"].includes(args[index]) ||
      args[index + 1] === undefined
    )
      throw new Error(
        "Use --list or --config <file> --task <id> --out <directory> [--repeats 3] [--timeout-ms 900000]",
      );
    values[args[index]] = args[index + 1];
  }
  if (!values["--config"] || !values["--task"] || !values["--out"])
    throw new Error("--config, --task and --out are required");
  const repeats = Number(values["--repeats"] ?? 3);
  const timeoutMs = Number(values["--timeout-ms"] ?? 900_000);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new Error("repeats must be 1–100");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error("timeout-ms must be 1–3600000");
  const configPath = resolve(values["--config"]);
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const results = [];
  for (let trial = 1; trial <= repeats; trial++) {
    results.push(
      await runTrial(config, values["--task"], {
        out: join(resolve(values["--out"]), String(trial)),
        trial,
        configDir: dirname(configPath),
        timeoutMs,
      }),
    );
  }
  const report = summarize(results);
  await writeFile(
    join(resolve(values["--out"]), "summary.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => !result.success)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
