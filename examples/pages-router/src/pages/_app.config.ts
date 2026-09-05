import type { PrachtAgentsConfig } from "@pracht/core";

// The pages router's equivalent of the `agents` and `constraints` keys an
// explicit manifest passes to `defineApp()`. Only these named exports are read;
// routes, shells, middleware, and capabilities stay file-discovered.
export const agents: PrachtAgentsConfig = {
  // Serve the `expose.mcp` capabilities as MCP tools at /mcp, for agents that
  // never open a browser.
  mcp: {
    serverInfo: { name: "pracht-pages-example", version: "0.0.0" },
    instructions: "Search blog posts in the pracht pages-router example app.",
  },
};
