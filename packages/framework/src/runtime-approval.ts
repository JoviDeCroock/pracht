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
 * The wire protocol does not change: callers still just echo the confirmation
 * token they were handed.
 */

import { sha256Base64Url } from "./runtime-confirmation.ts";
import type {
  CapabilityApprovalConsumeResult,
  CapabilityApprovalPrincipalResolver,
  CapabilityApprovalRecord,
  CapabilityApprovalStore,
  PrachtAgentIdentity,
  PrachtRequestContext,
} from "./types.ts";

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

export async function resolveCapabilityApprovalPrincipal<TContext>(options: {
  context: TContext;
  request: Request;
  capability: string;
  agent: PrachtAgentIdentity | null;
}): Promise<string | null> {
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
  return parts.length > 0 ? JSON.stringify(parts) : null;
}

/**
 * The proposal id for one destructive operation: base64url SHA-256 over the
 * principal, the capability name, and the input hash. Deriving it rather than
 * generating one means two prepare calls for the same operation address the
 * same proposal — a person approves the action, not a token — and no
 * client-supplied value ever selects a proposal.
 */
export async function capabilityApprovalId(
  principal: string,
  capability: string,
  inputHash: string,
): Promise<string> {
  return sha256Base64Url(JSON.stringify([principal, capability, inputHash]));
}

export interface MemoryApprovalStoreOptions {
  /** Clock override, unix seconds. Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * In-memory reference implementation.
 *
 * Correct for a single instance, and the semantics every other backend must
 * reproduce — but it is *not* durable: it is lost on restart and not shared
 * across replicas. Use it in tests, in development, and in single-instance
 * deployments; back a multi-replica deployment with a store that has
 * conditional writes.
 */
export function createMemoryApprovalStore(
  options: MemoryApprovalStoreOptions = {},
): CapabilityApprovalStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const records = new Map<string, CapabilityApprovalRecord>();

  // Keep the store's records private. In particular, returning the same object
  // from `get()` or `listPending()` would let application code change a pending
  // proposal to approved without going through `decide()`. Capability inputs
  // use the JSON data model, so structured cloning also isolates nested input.
  const cloneRecord = (record: CapabilityApprovalRecord): CapabilityApprovalRecord =>
    structuredClone(record);

  const sweep = (timestamp: number): void => {
    for (const [id, record] of records) {
      if (record.expiresAt < timestamp) records.delete(id);
    }
  };

  return {
    async create(record) {
      const timestamp = now();
      sweep(timestamp);
      const existing = records.get(record.id);
      if (existing && existing.expiresAt >= timestamp) {
        return cloneRecord(existing);
      }
      const stored = cloneRecord(record);
      records.set(stored.id, stored);
      return cloneRecord(stored);
    },

    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
    },

    async listPending() {
      const timestamp = now();
      return [...records.values()]
        .filter((record) => record.state === "pending" && record.expiresAt >= timestamp)
        .map(cloneRecord);
    },

    async decide(id, decision, by) {
      const timestamp = now();
      const record = records.get(id);
      if (!record || record.state !== "pending" || record.expiresAt < timestamp) return false;
      records.set(id, { ...record, state: decision, decidedBy: by, decidedAt: timestamp });
      return true;
    },

    // Read and write with no await in between: on a single-threaded runtime
    // that is the compare-and-set the store contract requires.
    async consume(id, consumeOptions): Promise<CapabilityApprovalConsumeResult> {
      const timestamp = now();
      const record = records.get(id);
      if (!record) return { ok: false, reason: "unknown" };
      if (record.expiresAt < timestamp) {
        records.delete(id);
        return { ok: false, reason: "expired" };
      }
      if (record.state === "consumed") return { ok: false, reason: "already_used" };
      if (record.state === "rejected") return { ok: false, reason: "rejected" };
      if (consumeOptions.requireApproval && record.state !== "approved") {
        return { ok: false, reason: "awaiting_approval" };
      }
      const consumed: CapabilityApprovalRecord = {
        ...record,
        state: "consumed",
      };
      records.set(id, consumed);
      return { ok: true, record: cloneRecord(consumed) };
    },
  };
}
