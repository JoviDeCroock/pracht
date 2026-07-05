import { format } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";

import { createPrachtMcpServer } from "../mcp-server.js";

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Start a Model Context Protocol server on stdio",
  },
  async run() {
    // The MCP protocol owns stdout: nothing but protocol frames may be
    // written to it. Route any stray logging to stderr instead.
    for (const method of ["debug", "error", "info", "log", "trace", "warn"] as const) {
      console[method] = (...args: unknown[]) => {
        process.stderr.write(`${format(...args)}\n`);
      };
    }

    const server = createPrachtMcpServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write("pracht MCP server listening on stdio\n");
  },
});
