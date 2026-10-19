import { defineCapability, type CapabilityAgentPolicy } from "../../../src/index.ts";

const guarded: { agentPolicy: CapabilityAgentPolicy; middleware: string[] } = {
  agentPolicy: "require",
  middleware: ["auth"],
};

export default defineCapability({
  title: "Spread guards",
  description: "Guards arrive through a spread the scan cannot follow.",
  input: { type: "object" },
  output: { type: "object" },
  effect: "read",
  expose: { http: true },
  ...guarded,
  async run() {
    return {};
  },
});
