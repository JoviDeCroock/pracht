import { defineCapability } from "../../../src/index.ts";

export default defineCapability({
  title: "Purge archive",
  description: "Destructive over HTTP and MCP, gated by confirmation.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "destructive",
  agentPolicy: "require",
  middleware: ["auth"],
  expose: { http: true, mcp: true, webmcp: false },
  async run() {
    return {};
  },
});
