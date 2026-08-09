import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";

/**
 * The one capability that answers **only** cryptographically verified agents.
 * `agentPolicy: "require"` overrides the app-wide `"observe"` default: unsigned
 * or unverifiable callers get the typed `401 { error: { code: "agent_required" } }`
 * envelope before any of this code runs.
 *
 * Not exposed to WebMCP on purpose — an in-page agent inherits the human's
 * cookie session, not a signed agent identity, so it would only ever see 401.
 */
export default defineCapability({
  title: "Agent operating brief",
  description:
    "House rules for autonomous callers: which tools exist, which are gated, and how the archive approval flow works. Verified agents only.",
  input: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      agentDomain: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      rules: { type: "array", items: { type: "string" } },
    },
    required: ["tools", "rules"],
  },
  effect: "read",
  agentPolicy: "require",
  expose: {
    http: true,
    mcp: true,
  },
  async run({ context }: CapabilityRunArgs<Record<string, never>>) {
    const brief: { agentDomain?: string; tools: string[]; rules: string[] } = {
      tools: [
        "projects.search — read, safe to call freely",
        "projects.create — write, rate limited per principal",
        "projects.deploy — write, pass idempotencyKey when retrying",
        "projects.archive — destructive, needs a human approval",
      ],
      rules: [
        "Archiving is two-phase: call once without a token to receive one, then repeat the identical input with the x-pracht-confirm header.",
        "A commit answered with 409 confirmation_pending is waiting on a reviewer at /app/approvals. Poll, do not re-prepare.",
        "Retry deploys with the same idempotencyKey; the server dedupes rather than shipping twice.",
        "Read /llms.txt for the full page and endpoint index.",
      ],
    };
    if (context.agent?.agentDomain) {
      brief.agentDomain = context.agent.agentDomain;
    }
    return brief;
  },
});
