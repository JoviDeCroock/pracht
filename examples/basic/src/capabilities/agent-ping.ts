import { defineCapability } from "@pracht/capabilities";

// agentPolicy "require" overrides the app-wide "observe" default: unsigned or
// unverified requests to this endpoint get a 401 agent_required envelope.
export default defineCapability({
  title: "Agent ping",
  description: "Answers only verified agents (Web Bot Auth required).",
  input: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      pong: { type: "boolean" },
    },
    required: ["pong"],
  },
  effect: "read",
  agentPolicy: "require",
  expose: {
    http: true,
  },
  async run() {
    return { pong: true };
  },
});
