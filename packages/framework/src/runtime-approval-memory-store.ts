import type {
  CapabilityApprovalConsumeResult,
  CapabilityApprovalRecord,
  CapabilityApprovalStore,
} from "./types.ts";

export interface MemoryApprovalStoreOptions {
  /** Clock override, unix seconds. Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * In-memory reference implementation of the approval-store contract.
 *
 * Correct for one instance, but neither durable nor shared across replicas.
 * Multi-replica backends must reproduce its conditional-write and exactly-once
 * consumption semantics with persistent storage.
 */
export function createMemoryApprovalStore(
  options: MemoryApprovalStoreOptions = {},
): CapabilityApprovalStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const records = new Map<string, CapabilityApprovalRecord>();
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
      if (existing && existing.expiresAt >= timestamp) return cloneRecord(existing);
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
    // No await between read and write: the single-threaded reference form of
    // the compare-and-set required from durable backends.
    async consume(id): Promise<CapabilityApprovalConsumeResult> {
      const timestamp = now();
      const record = records.get(id);
      if (!record) return { ok: false, reason: "unknown" };
      if (record.expiresAt < timestamp) {
        records.delete(id);
        return { ok: false, reason: "expired" };
      }
      if (record.state === "consumed") return { ok: false, reason: "already_used" };
      if (record.state === "rejected") return { ok: false, reason: "rejected" };
      if (record.requiresApproval && record.state !== "approved") {
        return { ok: false, reason: "awaiting_approval" };
      }
      const consumed: CapabilityApprovalRecord = { ...record, state: "consumed" };
      records.set(id, consumed);
      return { ok: true, record: cloneRecord(consumed) };
    },
  };
}
