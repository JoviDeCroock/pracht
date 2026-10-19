import { defineCapability } from "../../../src/index.ts";

export default defineCapability({
  title: "Search reviews",
  description: "Results carry user-generated text.",
  input: { type: "object", properties: { q: { type: "string" } } },
  output: { type: "object" },
  effect: "read",
  agentPolicy: "observe",
  middleware: ["auth", "audit"],
  expose: { http: { path: "/api/reviews/search" }, webmcp: { untrustedContent: true } },
  async run() {
    return {};
  },
});
