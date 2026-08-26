import { createMemoryApprovalStore, setCapabilityApprovalStore } from "@pracht/core/server";

/**
 * Durable approvals for destructive capabilities.
 *
 * Registering a store is what makes a commit exactly-once: prepare records a
 * proposal, commit consumes it. The remote MCP projection *requires* one before
 * it will serve destructive tools (`agents.mcp.destructive`), because a
 * stateless confirmation token can otherwise be replayed until it expires.
 *
 * This example uses the in-memory reference store: correct for one instance,
 * lost on restart. A real deployment should use `createSqlApprovalStore()` over
 * D1, Postgres, or Turso — see docs/AGENT_TRUST.md.
 *
 * Imported by `src/capabilities/notes-purge.ts` so the registration runs before
 * the capability graph is served.
 */
export const approvalStore = createMemoryApprovalStore();

setCapabilityApprovalStore(approvalStore);
