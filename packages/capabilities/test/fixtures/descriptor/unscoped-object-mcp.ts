import { defineCapability } from "../../../src/index.ts";

export default defineCapability({
  title: "Unscoped object form",
  description: "An empty scopes list is the same as no scopes.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "write",
  expose: { http: { method: "POST" }, mcp: { scopes: [] } },
  async run() {
    return {};
  },
});
