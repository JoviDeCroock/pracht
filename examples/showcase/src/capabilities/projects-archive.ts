import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";
import { archiveProject } from "../server/projects-store.ts";

interface ArchiveInput {
  projectId: string;
  reason?: string;
}

/**
 * The destructive one — and the reason the trust layer exists.
 *
 * `destructive` cannot be exposed to WebMCP or MCP at all: `defineCapability()`
 * rejects it, the registry rejects it, and `pracht verify` rejects it. HTTP
 * exposure is allowed only behind the server-verified prepare/commit flow.
 *
 * This app runs `confirmation: { mode: "human" }` with an approval store, so
 * the flow is:
 *
 *   1. caller POSTs with no token          → 409 confirmation_required + token
 *   2. caller repeats it with the token    → 409 confirmation_pending + approvalId
 *   3. a person approves at /app/approvals
 *   4. caller repeats it again             → runs, exactly once
 *
 * Nobody can approve their own call by holding the token: the token proves
 * deliberateness, the store's decision proves consent.
 */
export default defineCapability({
  title: "Archive project",
  description:
    "Permanently archive a project. Requires a human approval before it runs — the caller receives a confirmation token, then waits for a reviewer.",
  input: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1 },
      reason: {
        type: "string",
        maxLength: 200,
        description: "Shown to the reviewer in the approval inbox.",
      },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      archived: { type: "boolean" },
      projectId: { type: "string" },
      name: { type: "string" },
    },
    required: ["archived", "projectId"],
  },
  effect: "destructive",
  expose: {
    http: true,
  },
  async run({ input }: CapabilityRunArgs<ArchiveInput>) {
    const project = archiveProject(input.projectId);
    if (!project) {
      return { archived: false, projectId: input.projectId };
    }
    return { archived: true, projectId: project.id, name: project.name };
  },
});
