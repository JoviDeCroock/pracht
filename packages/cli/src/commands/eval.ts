import type { ChildProcess } from "node:child_process";
import { relative } from "node:path";

import { defineCommand } from "citty";

import {
  findEvalFiles,
  parseScenario,
  runScenario,
  waitForServer,
  type EvalScenarioResult,
} from "../eval-runner.js";
import { startManagedCommand, stopProcessTree } from "../managed-command.js";

const DEFAULT_START_URL = "http://localhost:3000";

export default defineCommand({
  meta: {
    name: "eval",
    description:
      "Run scripted agent-task scenarios over capability HTTP, remote MCP, or browser WebMCP",
  },
  args: {
    files: {
      type: "positional",
      description: "Scenario files (defaults to evals/**/*.eval.json)",
      required: false,
    },
    url: {
      type: "string",
      description: "Base URL of the running app (overrides per-file url)",
    },
    start: {
      type: "string",
      description:
        'Command that starts your app (e.g. "pracht preview"). pracht eval launches it, ' +
        `waits for a response at --url (default ${DEFAULT_START_URL}), runs the scenarios, ` +
        "then stops it",
    },
    browser: {
      type: "string",
      description: "Chrome/Chromium executable used by WebMCP scenarios",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const explicit = (args._ ?? []).map(String);
    const files = findEvalFiles(cwd, explicit);

    if (files.length === 0) {
      console.error(
        explicit.length > 0
          ? "No scenario files matched."
          : "No evals/**/*.eval.json scenario files found. Pass files explicitly: pracht eval <file...>",
      );
      process.exitCode = 1;
      return;
    }

    let urlOverride = args.url ? String(args.url) : undefined;
    let child: ChildProcess | undefined;
    let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;

    const releaseSignalHandler = (): void => {
      if (!signalHandler) return;
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
      signalHandler = undefined;
    };

    if (args.start) {
      const startCommand = String(args.start);
      // One started server serves every scenario, so its URL overrides
      // per-file urls too.
      const baseUrl = urlOverride ?? DEFAULT_START_URL;
      urlOverride = baseUrl;

      let output = "";
      let exitReason: string | null = null;
      const managed = startManagedCommand(startCommand);
      child = managed.child;
      const syncManagedState = (): void => {
        output = managed.output();
        exitReason = managed.earlyExit();
      };

      // A detached child (its own process group) does not receive the
      // terminal's Ctrl+C, so stop it explicitly before exiting — otherwise it
      // orphans and keeps holding its port.
      signalHandler = (signal) => {
        stopStartedCommand(child!);
        process.exit(signal === "SIGINT" ? 130 : 143);
      };
      process.once("SIGINT", signalHandler);
      process.once("SIGTERM", signalHandler);

      if (!args.json) {
        console.log(`Starting app: ${startCommand}`);
        console.log(`Waiting for ${baseUrl} ...`);
      }
      const ready = await waitForServer(baseUrl, {
        earlyExit: () => {
          syncManagedState();
          return exitReason;
        },
      });
      if (!ready.ok) {
        syncManagedState();
        releaseSignalHandler();
        stopStartedCommand(child);
        console.error(`Could not reach the app at ${baseUrl}: ${ready.reason}`);
        if (output.trim() !== "") {
          console.error(`\n--- start command output ---\n${output.trimEnd()}`);
        }
        process.exitCode = 1;
        return;
      }
    }

    try {
      const results: EvalScenarioResult[] = [];
      for (const file of files) {
        results.push(
          await runEvalFile(
            file,
            cwd,
            urlOverride,
            args.browser ? String(args.browser) : undefined,
          ),
        );
      }

      const ok = results.every((result) => result.ok && result.error === null);
      if (args.json) {
        console.log(JSON.stringify({ ok, scenarios: results }, null, 2));
      } else {
        printTranscript(results, cwd);
      }
      if (!ok) {
        process.exitCode = 1;
      }
    } finally {
      releaseSignalHandler();
      if (child) {
        stopStartedCommand(child);
      }
    }
  },
});

/** Stop the `--start` process — the whole group on POSIX (`shell: true` spawns children). */
function stopStartedCommand(child: ChildProcess): void {
  stopProcessTree(child);
}

async function runEvalFile(
  file: string,
  cwd: string,
  urlOverride: string | undefined,
  browserExecutable: string | undefined,
): Promise<EvalScenarioResult> {
  let scenario;
  try {
    scenario = parseScenario(file);
  } catch (error: unknown) {
    return {
      name: relative(cwd, file),
      file,
      // The file never parsed, so its transport is unknown; report the default.
      transport: "http",
      ok: false,
      steps: [],
      error: `could not load scenario: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const baseUrl = urlOverride ?? scenario.url;
  if (!baseUrl) {
    return {
      name: scenario.name,
      file,
      transport: scenario.transport ?? "http",
      ok: false,
      steps: [],
      error:
        'no target server: pass --url <base> or set "url" in the scenario file. ' +
        "Tip: run `pracht preview` (or `pracht dev`) in another terminal and point --url at it, " +
        'or let pracht eval manage the server with --start "pracht preview".',
    };
  }

  return runScenario(scenario, file, { baseUrl, browserExecutable });
}

function printTranscript(results: EvalScenarioResult[], cwd: string): void {
  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const marker = result.ok && result.error === null ? "PASS" : "FAIL";
    // The transport is worth a line of its own: the same scenario passing over
    // HTTP says nothing about whether an MCP host can reach the capability.
    // Read from the scenario result, not its first step — a scenario that fails
    // during the handshake has no steps and is exactly when this matters.
    const transport = result.transport === "http" ? "" : `  [${result.transport}]`;
    console.log(`\n${marker}  ${result.name}${transport}  (${relative(cwd, result.file)})`);
    if (result.error) {
      console.log(`      ${result.error}`);
    }
    for (const [index, step] of result.steps.entries()) {
      const outcome = step.ok ? "ok" : (step.errorCode ?? `status ${step.status}`);
      const stepMarker = step.failures.length === 0 ? "✓" : "✗";
      console.log(
        `  ${stepMarker} ${index + 1}. ${step.capability} → ${outcome} ` +
          `(${step.status}, ${step.latencyMs.toFixed(0)}ms)`,
      );
      for (const failure of step.failures) {
        console.log(`      ${failure}`);
      }
    }
    if (result.ok && result.error === null) passed += 1;
    else failed += 1;
  }

  console.log(`\n${passed} scenario(s) passed, ${failed} failed.`);
}
