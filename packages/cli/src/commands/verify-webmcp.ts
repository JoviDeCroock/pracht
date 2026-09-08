import { defineCommand } from "citty";

import {
  findEvalFiles,
  parseScenario,
  runScenario,
  waitForServer,
  type EvalScenarioResult,
} from "../eval-runner.js";
import { startManagedCommand, type ManagedCommand } from "../managed-command.js";
import { requirePositiveInteger } from "../utils.js";
import { runWebmcpVerification, type WebmcpVerificationReport } from "../webmcp-verification.js";

const DEFAULT_START_URL = "http://localhost:3000";

export default defineCommand({
  meta: {
    name: "webmcp",
    description: "Verify the live browser WebMCP registry against the resolved app graph",
  },
  args: {
    url: {
      type: "string",
      description: `Base URL of the running app (default with --start: ${DEFAULT_START_URL})`,
    },
    start: {
      type: "string",
      description:
        'Command that starts your app (e.g. "pracht preview"); it is stopped after verification',
    },
    browser: {
      type: "string",
      description: "Pinned Chrome/Chromium executable path (auto-detected when omitted)",
    },
    timeout: {
      type: "string",
      description: "Browser, navigation, and app startup timeout in milliseconds (default: 10000)",
    },
    scenario: {
      type: "string",
      description:
        "Comma-separated WebMCP eval scenario files whose safe invocations should also run",
    },
    json: {
      type: "boolean",
      description: "Output stable machine-readable JSON",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    const timeoutMs = requirePositiveInteger(
      args.timeout ? String(args.timeout) : undefined,
      "timeout",
      10_000,
    );
    const baseUrl = args.url ? String(args.url) : DEFAULT_START_URL;
    let started: ManagedCommand | undefined;
    let interruptedSignal: NodeJS.Signals | undefined;
    const abortController = new AbortController();
    const onSignal = (signal: NodeJS.Signals): void => {
      interruptedSignal = signal;
      abortController.abort();
      started?.stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      if (args.start) {
        started = startManagedCommand(String(args.start));
        if (!json) {
          console.log(`Starting app: ${String(args.start)}`);
          console.log(`Waiting for ${baseUrl} ...`);
        }
        const ready = await waitForServer(baseUrl, {
          timeoutMs,
          earlyExit: started.earlyExit,
        });
        if (!ready.ok) {
          const report = startupFailure(
            `Could not reach the app at ${baseUrl}: ${ready.reason}`,
            started.output(),
          );
          outputWebmcpReport(report, json);
          process.exitCode = 1;
          return;
        }
      } else {
        const ready = await waitForServer(baseUrl, { timeoutMs: Math.min(timeoutMs, 2_000) });
        if (!ready.ok) {
          const report = startupFailure(
            `Could not reach the app at ${baseUrl}: ${ready.reason}. ` +
              'Start it first, or let the verifier own it with --start "pracht preview".',
          );
          outputWebmcpReport(report, json);
          process.exitCode = 1;
          return;
        }
      }

      const verification = await runWebmcpVerification(process.cwd(), {
        baseUrl,
        browserExecutable: args.browser ? String(args.browser) : undefined,
        signal: abortController.signal,
        timeoutMs,
      });
      const invocations = verification.ok
        ? await runInvocationScenarios({
            browserExecutable: args.browser ? String(args.browser) : undefined,
            files: args.scenario ? String(args.scenario) : undefined,
            baseUrl,
            timeoutMs,
          })
        : [];
      const invocationFailed = invocations.some(
        (scenario) => !scenario.ok || scenario.error !== null,
      );
      const report = {
        ...verification,
        invocations,
        error: invocationFailed
          ? "One or more configured WebMCP invocation scenarios failed."
          : verification.error,
        ok: verification.ok && !invocationFailed,
        status: invocationFailed ? ("invocation-failure" as const) : verification.status,
      };
      outputWebmcpReport(report, json);
      process.exitCode =
        interruptedSignal === "SIGINT" ? 130 : interruptedSignal ? 143 : report.ok ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      started?.stop();
    }
  },
});

type CommandReport =
  | (Omit<WebmcpVerificationReport, "status"> & {
      invocations?: EvalScenarioResult[];
      status: WebmcpVerificationReport["status"] | "invocation-failure";
    })
  | ReturnType<typeof startupFailure>;

function startupFailure(error: string, output = "") {
  return {
    browser: null,
    error,
    ok: false as const,
    invocations: [] as EvalScenarioResult[],
    routes: [],
    status: "app-startup-failure" as const,
    support: null,
    ...(output.trim() ? { startOutput: output.trimEnd() } : {}),
  };
}

function outputWebmcpReport(report: CommandReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Pracht verify webmcp");
  if (report.browser) {
    console.log(
      `Browser ${report.browser.name} ${report.browser.version} (${report.browser.executable})`,
    );
  }
  for (const route of report.routes) {
    const expected = route.expectedTools.map((tool) => tool.name).join(", ") || "none";
    const observed = route.observedTools.map((tool) => tool.name).join(", ") || "none";
    const marker = route.mismatches.length === 0 ? "PASS" : "FAIL";
    console.log(
      `${marker.padEnd(5)} ${route.route} (${route.navigation} navigation) expected=[${expected}] observed=[${observed}]`,
    );
    for (const mismatch of route.mismatches) {
      if (mismatch.kind === "missing") {
        console.log(`      missing tool ${mismatch.tool}`);
      } else if (mismatch.kind === "unexpected") {
        console.log(`      unexpected tool ${mismatch.tool}`);
      } else if (mismatch.kind === "route") {
        console.log(`      navigation resolved to ${String(mismatch.actual)}`);
      } else {
        console.log(
          `      ${mismatch.tool}.${mismatch.field}: expected ${JSON.stringify(mismatch.expected)}, got ${JSON.stringify(mismatch.actual)}`,
        );
      }
    }
  }
  for (const scenario of report.invocations ?? []) {
    const marker = scenario.ok && scenario.error === null ? "PASS" : "FAIL";
    console.log(`${marker.padEnd(5)} invocation scenario ${scenario.name}`);
    if (scenario.error) console.log(`      ${scenario.error}`);
    for (const step of scenario.steps) {
      for (const failure of step.failures) console.log(`      ${step.capability}: ${failure}`);
    }
  }
  if (report.routes.length === 0 && report.ok) {
    console.log("PASS  No routes activate WebMCP capabilities.");
  }
  console.log(report.ok ? "\nLive WebMCP verification passed." : `\n${report.error}`);
  if ("startOutput" in report) {
    console.log(`\n--- start command output ---\n${report.startOutput}`);
  }
}

async function runInvocationScenarios(options: {
  baseUrl: string;
  browserExecutable?: string;
  files?: string;
  timeoutMs: number;
}): Promise<EvalScenarioResult[]> {
  if (!options.files) return [];
  const files = findEvalFiles(
    process.cwd(),
    options.files
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean),
  );
  const results: EvalScenarioResult[] = [];
  for (const file of files) {
    let scenario;
    try {
      scenario = parseScenario(file);
      if (scenario.transport !== "webmcp") {
        throw new Error('verification invocation scenarios must set "transport": "webmcp"');
      }
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        file,
        name: file,
        ok: false,
        steps: [],
        transport: "webmcp",
      });
      continue;
    }
    results.push(
      await runScenario(scenario, file, {
        baseUrl: options.baseUrl,
        browserExecutable: options.browserExecutable,
        timeoutMs: options.timeoutMs,
      }),
    );
  }
  return results;
}
