import { defineCapability } from "@pracht/capabilities";

// Echoes the Web Bot Auth verification result so agents (and the e2e suite)
// can see what identity the server established. Policy stays "observe":
// unsigned callers are served and simply see verified: false. The default
// capability context already types `context.agent` — no custom context type.
export default defineCapability<Record<string, never>>({
  title: "Agent whoami",
  description: "Report the verified Web Bot Auth agent identity for this request.",
  input: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      verified: { type: "boolean" },
      agentDomain: { type: "string" },
      keyId: { type: "string" },
    },
    required: ["verified"],
  },
  effect: "read",
  expose: {
    http: true,
  },
  async run({ context }) {
    const agent = context.agent ?? null;
    if (!agent) {
      return { verified: false };
    }
    const identity: { verified: boolean; agentDomain?: string; keyId: string } = {
      verified: true,
      keyId: agent.keyId,
    };
    if (agent.agentDomain) {
      identity.agentDomain = agent.agentDomain;
    }
    return identity;
  },
});
