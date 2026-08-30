/**
 * Durable approvals for destructive capabilities. The implementation lives in
 * `@pracht/capabilities/server` — the capability core — so a standalone host
 * shares the same registration slots and store contracts; re-exported here
 * because it has always been part of `@pracht/core`'s surface.
 */

export {
  capabilityApprovalId,
  createMemoryApprovalStore,
  createSqlApprovalStore,
  hasCapabilityApprovalPrincipalResolver,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
  type MemoryApprovalStoreOptions,
  type ResolvedCapabilityApprovalPrincipal,
  type SqlApprovalStoreDialect,
  type SqlApprovalStoreExecute,
  type SqlApprovalStoreOptions,
  type SqlApprovalStoreResult,
} from "@pracht/capabilities/server";
