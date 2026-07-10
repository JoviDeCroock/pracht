import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { VERSION } from "./constants.js";
import { readProjectConfig } from "./project.js";
import { runDoctor, runVerification } from "./verification.js";
import {
  generateApi,
  generateMiddleware,
  generateRoute,
  generateShell,
} from "./commands/generate.js";
import { runInspect } from "./commands/inspect.js";

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
        "Inspect the resolved page-route graph of a pracht app: path, id, render mode, shell, middleware, loader file. Same payload as `pracht inspect routes --json`.",
      inputSchema: { ...cwdInput },
    },
    guard(({ cwd }) => runInspect(resolveCwd(cwd), { target: "routes" })),
  );

  server.registerTool(
    "inspect_api",
    {
      description:
        "Inspect the resolved API routes of a pracht app: endpoint path, source file, exported HTTP methods. Same payload as `pracht inspect api --json`.",
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
