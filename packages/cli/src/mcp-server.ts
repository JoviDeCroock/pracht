import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { VERSION } from "./constants.js";
import { registerGenerationTools } from "./mcp-server/generation-tools.js";
import { registerInspectionTools } from "./mcp-server/inspection-tools.js";
import { registerWorkflowTools } from "./mcp-server/workflow-tools.js";

/** Create the local Pracht MCP server and install its complete tool catalog. */
export function createPrachtMcpServer(): McpServer {
  const server = new McpServer({
    name: "pracht",
    version: VERSION,
  });

  registerInspectionTools(server);
  registerWorkflowTools(server);
  registerGenerationTools(server);

  return server;
}
