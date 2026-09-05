/**
 * Durable approvals for destructive capabilities. The implementation lives in
 * `@pracht/capabilities/server/internal` — the capability core — so a standalone host
 * shares the same registration slots and store contracts; re-exported here
 * because it has always been part of `@pracht/core`'s surface.
 */

import { setCapabilityApprovalPrincipalResolver as setCapabilityApprovalPrincipalResolverShared } from "@pracht/capabilities/server/internal";
import type { CapabilityApprovalPrincipalResolver, PrachtRequestContext } from "./types.ts";

export {
  capabilityApprovalId,
  createMemoryApprovalStore,
  createSqlApprovalStore,
  hasCapabilityApprovalPrincipalResolver,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
  setCapabilityApprovalStore,
  type MemoryApprovalStoreOptions,
  type ResolvedCapabilityApprovalPrincipal,
  type SqlApprovalStoreDialect,
  type SqlApprovalStoreExecute,
  type SqlApprovalStoreOptions,
  type SqlApprovalStoreResult,
} from "@pracht/capabilities/server/internal";

/**
 * Register a server-only resolver for the application-authenticated identity
 * bound to approval proposals. Human approval without either this identity or
 * a verified agent identity fails closed.
 *
 * The implementation lives in `@pracht/capabilities/server/internal`, where the
 * context type defaults to `unknown`; this re-declaration restores the
 * framework default (`PrachtRequestContext`) so an app resolver can read its
 * registered context without a type argument.
 */
export const setCapabilityApprovalPrincipalResolver =
  setCapabilityApprovalPrincipalResolverShared as <TContext = PrachtRequestContext>(
    resolver: CapabilityApprovalPrincipalResolver<TContext> | null,
  ) => void;
