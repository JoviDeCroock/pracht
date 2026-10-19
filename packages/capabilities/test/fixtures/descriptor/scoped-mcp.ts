import { defineCapability } from "../../../src/index.ts";

export default defineCapability({
  title: "Read the ledger",
  description: "Scoped remote MCP tool; duplicate scopes collapse.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: {}, additionalProperties: false },
  effect: "read",
  expose: { mcp: { scopes: ["ledger:read", "ledger:read", "openid"] } },
  async run() {
    return {};
  },
});
