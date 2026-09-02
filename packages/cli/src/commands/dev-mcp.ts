import { format } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";

import { createPrachtMcpServer } from "../mcp-server.js";

/**
 * Shared by `dev-mcp` and its deprecated `mcp` alias.
 *
 * The MCP protocol owns stdout: nothing but protocol frames may be written to
 * it, so any stray logging is routed to stderr instead.
 */
export async function startDevMcpServer(): Promise<void> {
  for (const method of ["debug", "error", "info", "log", "trace", "warn"] as const) {
    console[method] = (...args: unknown[]) => {
      process.stderr.write(`${format(...args)}\n`);
    };
  }

  const server = createPrachtMcpServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("pracht dev-mcp server listening on stdio\n");
}

export default defineCommand({
  meta: {
    name: "dev-mcp",
    description: "Start the authoring Model Context Protocol server on stdio",
  },
  run: startDevMcpServer,
});
