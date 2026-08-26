import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import { purgeNotes } from "../server/notes-store.ts";
// Registers the approval store. Destructive tools over remote MCP need one, and
// importing it from a capability module means it is registered before the graph
// is ever served.
import "../server/approvals.ts";

interface PurgeInput {
  titlePrefix: string;
}

// Destructive demo capability, exposed over HTTP *and* remote MCP — which means
// every dispatch goes through the server-verified prepare/commit confirmation
// flow. The first call answers 409 confirmation_required with a token, and only
// a second call with identical input plus the token runs: over HTTP the token
// travels in the x-pracht-confirm header, over MCP in
// `_meta["io.pracht/confirmation"]` on `tools/call`.
//
// Requires PRACHT_CONFIRMATION_SECRET in the environment, plus
// `agents.mcp.destructive` and a registered approval store for the MCP half.
export default defineCapability({
  title: "Purge notes",
  description: "Permanently delete every note whose title starts with the prefix.",
  input: {
    type: "object",
    properties: {
      titlePrefix: { type: "string", minLength: 3 },
    },
    required: ["titlePrefix"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      purged: { type: "integer", minimum: 0 },
    },
    required: ["purged"],
  },
  effect: "destructive",
  expose: {
    http: true,
    mcp: true,
  },
  async run({ input }: CapabilityRunArgs<PurgeInput>) {
    return { purged: purgeNotes(input.titlePrefix) };
  },
});
