import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runInspect } from "../inspect.js";
import { cwdInput, guard, resolveCwd } from "./tool-helpers.js";

export function registerInspectionTools(server: McpServer): void {
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
}
