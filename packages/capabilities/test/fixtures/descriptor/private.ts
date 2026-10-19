import { defineCapability } from "../../../src/index.ts";

export default defineCapability({
  title: "Recalculate totals",
  description: "Server-only.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "write",
  async run() {
    return {};
  },
});
