import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  generateApi,
  generateCapability,
  generateMiddleware,
  generateRoute,
  generateShell,
} from "../generation/index.js";
import { readProjectConfig } from "../project.js";
import { cwdInput, guard, resolveCwd } from "./tool-helpers.js";

export function registerGenerationTools(server: McpServer): void {
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
}
