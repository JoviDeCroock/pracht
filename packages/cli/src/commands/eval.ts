import { relative } from "node:path";

import { defineCommand } from "citty";

import {
  findEvalFiles,
  parseScenario,
  runScenario,
  type EvalScenarioResult,
} from "../eval-runner.js";

export default defineCommand({
  meta: {
    name: "eval",
    description: "Run scripted agent-task scenarios against the capability HTTP projection",
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

    const results: EvalScenarioResult[] = [];
    for (const file of files) {
      results.push(await runEvalFile(file, cwd, args.url ? String(args.url) : undefined));
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
  },
});

async function runEvalFile(
  file: string,
  cwd: string,
  urlOverride: string | undefined,
): Promise<EvalScenarioResult> {
  let scenario;
  try {
    scenario = parseScenario(file);
  } catch (error: unknown) {
    return {
      name: relative(cwd, file),
      file,
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
      ok: false,
      steps: [],
      error:
        'no target server: pass --url <base> or set "url" in the scenario file. ' +
        "Tip: run `pracht preview` (or `pracht dev`) in another terminal and point --url at it.",
    };
  }

  return runScenario(scenario, file, { baseUrl });
}

function printTranscript(results: EvalScenarioResult[], cwd: string): void {
  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const marker = result.ok && result.error === null ? "PASS" : "FAIL";
    console.log(`\n${marker}  ${result.name}  (${relative(cwd, result.file)})`);
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
