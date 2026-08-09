import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";

/**
 * Echoes back the Web Bot Auth verification result, so a caller can see exactly
 * what identity the server established for it. App policy is `"observe"`:
 * unsigned callers are served and simply see `verified: false`.
 *
 * `context.agent` is typed by the default capability context — no hand-rolled
 * context interface needed.
 */
export default defineCapability({
  title: "Who am I",
  description:
    "Report the verified Web Bot Auth (RFC 9421) identity Launchpad established for this request.",
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
      policy: { type: "string" },
    },
    required: ["verified", "policy"],
  },
  effect: "read",
  expose: {
    http: true,
    webmcp: true,
    mcp: true,
  },
  async run({ context }: CapabilityRunArgs<Record<string, never>>) {
    const agent = context.agent ?? null;
    if (!agent) {
      return { verified: false, policy: "observe" };
    }
    const identity: {
      verified: boolean;
      keyId: string;
      policy: string;
      agentDomain?: string;
    } = { verified: true, keyId: agent.keyId, policy: "observe" };
    if (agent.agentDomain) {
      identity.agentDomain = agent.agentDomain;
    }
    return identity;
  },
});
