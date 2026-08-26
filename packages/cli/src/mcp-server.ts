import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { AUTHORING_GUIDE } from "./authoring-guide.js";
import { VERSION } from "./constants.js";
import { readProjectConfig } from "./project.js";
import { runDoctor, runVerification } from "./verification.js";
import {
  generateApi,
  generateCapability,
  generateMiddleware,
  generateRoute,
  generateShell,
} from "./commands/generate.js";
import { runInspect } from "./commands/inspect.js";
import {
  DEFAULT_CAPABILITIES_OUT,
  DEFAULT_DECLARATION_OUT,
  DEFAULT_RUNTIME_OUT,
  runTypegen,
} from "./commands/typegen.js";
import { findEvalFiles, parseScenario, runScenario } from "./eval-runner.js";
import { DEFAULT_BASE_REF, runPlan } from "./commands/plan.js";
import { runReport } from "./commands/report.js";

const cwdInput = {
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to the pracht app root. Defaults to the server's working directory."),
};

export function createPrachtMcpServer(): McpServer {
  const server = new McpServer({
    name: "pracht",
    version: VERSION,
  });

  server.registerTool(
    "inspect_routes",
    {
      description:
        "Inspect the resolved page-route graph of a pracht app: path, id, render mode, hydration mode, prefetch strategy, speculation rules, shell, middleware, loader file. Same payload as `pracht inspect routes --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runInspect(resolveCwd(cwd), { target: "routes" })),
  );

  server.registerTool(
    "inspect_api",
    {
      description:
        "Inspect the resolved API routes of a pracht app: endpoint path, source file, exported HTTP methods, and whether the module exports a default catch-all handler (`hasDefaultHandler`). Same payload as `pracht inspect api --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runInspect(resolveCwd(cwd), { target: "api" })),
  );

  server.registerTool(
    "inspect_capabilities",
    {
      description:
        "Inspect the registered capabilities of a pracht app: name, effect class, exposure transports (http/mcp/webmcp), HTTP path, middleware, source file. Same payload as `pracht inspect capabilities --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runInspect(resolveCwd(cwd), { target: "capabilities" })),
  );

  server.registerTool(
    "inspect_build",
    {
      description:
        "Inspect build metadata of a pracht app: adapter target, client entry URL, CSS/JS manifests. Requires a prior `pracht build`. Same payload as `pracht inspect build --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runInspect(resolveCwd(cwd), { target: "build" })),
  );

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
        'Run scripted agent-task scenarios (evals/**/*.eval.json) against an already-running app\'s agent surface — the capability HTTP projection, or the remote MCP endpoint when the scenario sets "transport": "mcp". Start the app yourself first and pass its base URL. Reports each step\'s outcome and whether the scenario passed.',
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
      // Per file, like the CLI: a malformed scenario used to throw out of the
      // loop, discarding every scenario that had already passed and reporting
      // a bare parse message with no filename.
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

  server.registerTool(
    "generate_route",
    {
      description:
        "Scaffold a pracht route module and wire it into the app (manifest apps update src/routes.ts; pages apps create the page file). Returns the files created and updated.",
      inputSchema: {
        ...cwdInput,
        path: z.string().describe("Route path, e.g. /dashboard or /blog/:slug"),
        render: z
          .enum(["spa", "ssr", "ssg", "isg"])
          .optional()
          .describe("Render mode (defaults to ssr)."),
        shell: z.string().optional().describe("Registered shell name (manifest apps only)."),
        middleware: z
          .array(z.string())
          .optional()
          .describe("Registered middleware names (manifest apps only)."),
        loader: z.boolean().optional().describe("Include a loader export."),
        errorBoundary: z.boolean().optional().describe("Include an error boundary export."),
        staticPaths: z.boolean().optional().describe("Include a getStaticPaths export."),
        title: z.string().optional().describe("Page title used in the head export."),
        revalidate: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("ISG revalidation window in seconds (isg render mode only)."),
        test: z
          .boolean()
          .optional()
          .describe(
            "Emit a Playwright smoke test in e2e/ (defaults to on when the app has a Playwright setup).",
          ),
      },
    },
    guard((input) => {
      const project = readProjectConfig(resolveCwd(input.cwd));
      return generateRoute(
        {
          "error-boundary": input.errorBoundary,
          loader: input.loader,
          middleware: input.middleware?.join(","),
          path: input.path,
          render: input.render,
          revalidate: input.revalidate === undefined ? undefined : String(input.revalidate),
          shell: input.shell,
          "static-paths": input.staticPaths,
          test: input.test,
          title: input.title,
        },
        project,
      );
    }),
  );

  server.registerTool(
    "generate_shell",
    {
      description:
        "Scaffold a pracht shell component and register it in the app manifest (manifest apps only). Returns the files created and updated.",
      inputSchema: {
        ...cwdInput,
        name: z.string().describe("Shell name, e.g. app or public"),
      },
    },
    guard(({ cwd, name }) => {
      const root = resolveCwd(cwd);
      return generateShell(name, readProjectConfig(root));
    }),
  );

  server.registerTool(
    "generate_middleware",
    {
      description:
        "Scaffold a pracht middleware function and register it in the app manifest (manifest apps only). Returns the files created and updated.",
      inputSchema: {
        ...cwdInput,
        name: z.string().describe("Middleware name, e.g. auth"),
      },
    },
    guard(({ cwd, name }) => {
      const root = resolveCwd(cwd);
      return generateMiddleware(name, readProjectConfig(root));
    }),
  );

  server.registerTool(
    "generate_capability",
    {
      description:
        "Scaffold a capability module (a typed operation callable from server code, HTTP, WebMCP, and remote MCP) and register it in the app manifest. Manifest apps only. Keeps `expose`/`effect`/`input` as inline literals, which the browser projection's static analysis requires. Then edit the schemas and run() body.",
      inputSchema: {
        ...cwdInput,
        name: z.string().describe("Dot-separated capability name, e.g. notes.search"),
        effect: z
          .enum(["read", "write", "destructive"])
          .optional()
          .describe(
            "Effect class (defaults to read). `destructive` may only be exposed over http and is confirmation-gated.",
          ),
        expose: z
          .array(z.enum(["http", "webmcp", "mcp"]))
          .optional()
          .describe("Transports to expose. Omit to keep the capability private."),
        title: z.string().optional().describe("Human-readable title."),
        description: z
          .string()
          .optional()
          .describe(
            "Contract description — the text an agent reads to decide whether to call the tool. Required whenever `expose` is set.",
          ),
      },
    },
    guard(({ cwd, description, effect, expose, name, title }) =>
      generateCapability(
        { description, effect, expose: expose?.join(","), name, title },
        readProjectConfig(resolveCwd(cwd)),
      ),
    ),
  );

  server.registerTool(
    "generate_api",
    {
      description:
        "Scaffold a pracht API route with typed HTTP method handlers. Returns the files created and updated.",
      inputSchema: {
        ...cwdInput,
        path: z.string().describe("API endpoint path, e.g. /health or /users/:id"),
        methods: z
          .array(z.string())
          .optional()
          .describe('HTTP methods to scaffold, e.g. ["GET", "POST"] (defaults to GET).'),
      },
    },
    guard(({ cwd, methods, path }) => {
      const project = readProjectConfig(resolveCwd(cwd));
      return generateApi({ methods: methods?.join(","), path }, project);
    }),
  );

  return server;
}

function resolveCwd(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

function guard<Input>(
  handler: (input: Input) => Promise<unknown> | unknown,
): (input: Input) => Promise<CallToolResult> {
  return async (input) => {
    try {
      const result = await handler(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  };
}

/** Like guard(), but for handlers that already return display-ready text. */
function guardText<Input>(
  handler: (input: Input) => Promise<string> | string,
): (input: Input) => Promise<CallToolResult> {
  return async (input) => {
    try {
      return {
        content: [{ type: "text", text: await handler(input) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  };
}
