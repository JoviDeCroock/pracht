import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AUTHORING_GUIDE } from "../authoring-guide.js";
import { DEFAULT_BASE_REF, runPlan } from "../commands/plan.js";
import { runReport } from "../commands/report.js";
import {
  DEFAULT_CAPABILITIES_OUT,
  DEFAULT_DECLARATION_OUT,
  DEFAULT_RUNTIME_OUT,
  runTypegen,
} from "../typegen.js";
import { findEvalFiles, parseScenario, runScenario } from "../eval-runner.js";
import { runDoctor, runVerification } from "../verification.js";
import { cwdInput, guard, guardText, resolveCwd } from "./tool-helpers.js";

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "doctor",
    {
      description:
        "Validate pracht app wiring (config, manifest references, adapter dependency). Same payload as `pracht doctor --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runDoctor(resolveCwd(cwd))),
  );

  server.registerTool(
    "verify",
    {
      description:
        "Run fast framework-aware verification checks on a pracht app. Same payload as `pracht verify --json`.",
      inputSchema: {
        ...cwdInput,
        changed: z
          .boolean()
          .optional()
          .describe("Only check files changed according to git (maps to --changed)."),
      },
    },
    guard(({ changed, cwd }) => runVerification(resolveCwd(cwd), { changed: Boolean(changed) })),
  );

  server.registerTool(
    "plan",
    {
      description:
        "Semantic app-graph diff against a base git ref: routes/API/capabilities/constraints added, removed, and changed, plus `widensAgentSurface` when a capability change widened the agent-reachable surface. Same payload as `pracht plan --json`. Set write=true to refresh the committed .pracht/app-graph.json snapshot instead.",
      inputSchema: {
        ...cwdInput,
        base: z
          .string()
          .optional()
          .describe("Base git ref to diff against (defaults to origin/main)."),
        write: z
          .boolean()
          .optional()
          .describe("Write the current app graph to .pracht/app-graph.json instead of diffing."),
      },
    },
    guard(({ base, cwd, write }) =>
      runPlan(resolveCwd(cwd), {
        base: base ?? DEFAULT_BASE_REF,
        baseExplicit: base !== undefined,
        write: Boolean(write),
      }),
    ),
  );

  server.registerTool(
    "report",
    {
      description:
        "PR-ready markdown report assembled from machine truth: app-graph diff, `pracht verify` results, and client JS budgets. Use it as the factual half of a PR description.",
      inputSchema: {
        ...cwdInput,
        base: z
          .string()
          .optional()
          .describe("Base git ref to diff against (defaults to origin/main)."),
      },
    },
    guardText(({ base, cwd }) =>
      runReport(resolveCwd(cwd), {
        base: base ?? DEFAULT_BASE_REF,
        baseExplicit: base !== undefined,
      }),
    ),
  );

  server.registerTool(
    "typegen",
    {
      description:
        "Regenerate typed routes, href helpers, and capability types (src/pracht.d.ts, src/pracht-routes.ts, src/pracht-capabilities.d.ts). Run this after adding, removing, or renaming routes or capabilities. `check: true` reports staleness without writing. A non-empty `unreadableCapabilities` in the result means those capabilities' input and output types are `unknown` because their module could not be loaded.",
      inputSchema: {
        ...cwdInput,
        check: z
          .boolean()
          .optional()
          .describe("Report whether generated files are up to date instead of writing them."),
      },
    },
    guardText(async ({ check, cwd }) => {
      const result = await runTypegen({
        capabilitiesOut: DEFAULT_CAPABILITIES_OUT,
        check: Boolean(check),
        declarationOut: DEFAULT_DECLARATION_OUT,
        root: resolveCwd(cwd),
        runtimeOut: DEFAULT_RUNTIME_OUT,
      });
      return JSON.stringify(result, null, 2);
    }),
  );

  server.registerTool(
    "eval",
    {
      description:
        "Run scripted agent-task scenarios (evals/**/*.eval.json) against an already-running app's capability HTTP projection. Start the app yourself first and pass its base URL. Reports each step's outcome and whether the scenario passed.",
      inputSchema: {
        ...cwdInput,
        url: z.string().describe("Base URL of the running app, e.g. http://localhost:3000."),
        files: z
          .array(z.string())
          .optional()
          .describe("Scenario files. Defaults to evals/**/*.eval.json."),
      },
    },
    guardText(async ({ cwd, files, url }) => {
      const root = resolveCwd(cwd);
      const scenarioFiles = findEvalFiles(root, files ?? []);
      if (scenarioFiles.length === 0) {
        throw new Error(
          "No evals/**/*.eval.json scenario files found. Pass `files` explicitly to run specific scenarios.",
        );
      }

      // Load each file independently so one malformed scenario does not erase
      // successful results from the rest of the batch.
      const results = [];
      for (const file of scenarioFiles) {
        try {
          results.push(await runScenario(parseScenario(file), file, { baseUrl: url }));
        } catch (error) {
          results.push({
            file,
            name: file,
            ok: false,
            steps: [],
            error: `could not load scenario: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return JSON.stringify(
        { ok: results.every((result) => result.ok), scenarios: results },
        null,
        2,
      );
    }),
  );

  server.registerTool(
    "get_docs",
    {
      description:
        "The pracht authoring guide for coding agents: project layout, conventions, constraints, and the commands to run before finishing a change. Read this before authoring pracht app code.",
      inputSchema: {},
    },
    guardText(() => AUTHORING_GUIDE),
  );
}
