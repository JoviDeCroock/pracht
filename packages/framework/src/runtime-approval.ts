/**
 * Durable approvals for destructive capabilities.
 *
 * The stateless prepare/commit flow in runtime-confirmation.ts proves that a
 * commit is bound to one principal, one capability, and one exact input. Two
 * things it cannot prove on its own:
 *
 *   1. that the token is used only once — an HMAC is verifiable anywhere, so
 *      a captured token replays until it expires, on any replica;
 *   2. that a *person* agreed — the calling agent receives the token and can
 *      immediately hand it back to itself.
 *
 * Registering a {@link CapabilityApprovalStore} closes the replay gap. Prepare
 * records a proposal; commit verifies the HMAC first (so a forged token can
 * never burn a real proposal) and then asks the store to consume it exactly
 * once. Human mode additionally requires an authenticated principal from Web
 * Bot Auth or `setCapabilityApprovalPrincipalResolver()` before an out-of-band
 * decision can authorize the operation.
 *
 * The caller interaction does not change: callers still just echo the
 * confirmation token they were handed. Store-backed tokens use a distinct
 * version and bind the approval mode so older or differently configured
 * replicas reject them instead of bypassing the store.
 */

import { hmacSha256Base64Url, type CapabilityConfirmationMode } from "./runtime-confirmation.ts";
import type {
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalStore,
  PrachtAgentIdentity,
  PrachtRequestContext,
} from "./types.ts";

export { createMemoryApprovalStore } from "./runtime-approval-memory-store.ts";
export type { MemoryApprovalStoreOptions } from "./runtime-approval-memory-store.ts";

// Module-level registration, like `setCapabilityAuditHook` and
// `setCapabilityConfirmationSecret`: the app manifest carries serializable
// data only, so a store or resolver function cannot travel through it.
let approvalStore: CapabilityApprovalStore | null = null;
let approvalPrincipalResolver: CapabilityApprovalPrincipalResolver | null = null;

/**
 * Register the store backing destructive-capability approvals. Call it from a
 * server-only module (a capability module, middleware, or a custom server
 * entry). Passing `null` unregisters.
 */
export function setCapabilityApprovalStore(store: CapabilityApprovalStore | null): void {
  approvalStore = store;
}

export function resolveCapabilityApprovalStore(): CapabilityApprovalStore | null {
  return approvalStore;
}

/**
 * Register a server-only resolver for the application-authenticated identity
 * bound to approval proposals. Human approval without either this identity or
 * a verified agent identity fails closed.
 */
export function setCapabilityApprovalPrincipalResolver<TContext = PrachtRequestContext>(
  resolver: CapabilityApprovalPrincipalResolver<TContext> | null,
): void {
  approvalPrincipalResolver = resolver as CapabilityApprovalPrincipalResolver | null;
}

export interface ResolvedCapabilityApprovalPrincipal {
  /** Identity persisted with the proposal for review and correlation. */
  record: string;
  /** Opaque identity bound into the caller-visible confirmation token. */
  tokenBinding: string;
}

export async function resolveCapabilityApprovalPrincipal<TContext>(options: {
  context: TContext;
  request: Request;
  capability: string;
  agent: PrachtAgentIdentity | null;
  confirmationSecret: string;
}): Promise<ResolvedCapabilityApprovalPrincipal | null> {
  const applicationPrincipal = approvalPrincipalResolver
    ? await approvalPrincipalResolver({
        ...options,
        context: options.context as PrachtRequestContext,
      })
    : null;
  if (
    applicationPrincipal !== null &&
    (typeof applicationPrincipal !== "string" || applicationPrincipal.trim() === "")
  ) {
    throw new Error("the approval principal resolver must return a non-empty string or null");
  }

  const parts: string[] = [];
  if (options.agent) parts.push(`agent:${options.agent.keyId}`);
  if (applicationPrincipal) parts.push(`app:${applicationPrincipal}`);
  if (parts.length === 0) return null;

  // Preserve the original agent-only binding so confirmation tokens remain
  // valid across a rolling upgrade. Application identities are different:
  // they may be internal user or tenant ids, and confirmation-token claims are
  // only encoded, not encrypted, so bind an opaque digest instead.
  if (options.agent && !applicationPrincipal) {
    return { record: parts[0], tokenBinding: parts[0] };
  }
  const record = JSON.stringify(parts);
  return {
    record,
    tokenBinding: `approval:${await hmacSha256Base64Url(options.confirmationSecret, record)}`,
  };
}

/**
 * The proposal id for one destructive operation: a secret-keyed digest over
 * the principal, capability name, input hash, and approval mode. Deriving it
 * means two prepare calls for the same operation address the same proposal,
 * while keying it keeps caller-visible ids from revealing low-entropy
 * application principals through offline guessing.
 */
export async function capabilityApprovalId(
  confirmationSecret: string,
  principal: string,
  capability: string,
  inputHash: string,
  approvalMode: CapabilityConfirmationMode,
): Promise<string> {
  return hmacSha256Base64Url(
    confirmationSecret,
    `pracht-approval-id:${JSON.stringify([principal, capability, inputHash, approvalMode])}`,
  );
}
