import { defineCapability } from "../../../src/index.ts";

// Hoisted: static analysis cannot read these, the executed module can.
const EXPOSE = { http: true, mcp: { scopes: ["notes:write"] } } as const;
const TITLE = "Computed contract";

export default defineCapability({
  title: TITLE,
  description: "Exposure and title come from constants.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "write",
  expose: EXPOSE,
  async run() {
    return {};
  },
});
