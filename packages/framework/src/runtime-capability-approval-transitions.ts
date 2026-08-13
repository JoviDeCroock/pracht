import { errorEnvelope } from "./runtime-capability-pipeline.ts";
import type { CapabilityConfirmationMode } from "./runtime-confirmation-token.ts";
import type { CapabilityApprovalStore, CapabilityEnvelope } from "./types.ts";

export interface PrepareCapabilityApprovalOptions {
  store: CapabilityApprovalStore;
  approvalId: string;
  capability: string;
  exposeErrors: boolean;
  input: unknown;
  inputHash: string;
  mode: CapabilityConfirmationMode;
  principal: string;
  ttlSeconds: number;
}

export type CapabilityApprovalTransition<T> =
  | { ok: true; value: T }
  | { ok: false; failure: { status: number; envelope: CapabilityEnvelope } };

/** Create or reuse one durable proposal without extending its original life. */
export async function prepareCapabilityApproval(
  options: PrepareCapabilityApprovalOptions,
): Promise<CapabilityApprovalTransition<{ ttlSeconds: number }>> {
  const now = Math.floor(Date.now() / 1000);
  const created = await withApprovalStore(options.capability, options.exposeErrors, () =>
    options.store.create({
      id: options.approvalId,
      principal: options.principal,
      capability: options.capability,
      inputHash: options.inputHash,
      input: options.input,
      requiresApproval: options.mode === "human",
      createdAt: now,
      expiresAt: now + options.ttlSeconds,
      state: "pending",
      decidedBy: null,
      decidedAt: null,
    }),
  );
  if (!created.ok) return created;

  if (created.value.state === "consumed" || created.value.state === "rejected") {
    const reason = created.value.state === "consumed" ? "already_used" : "rejected";
    return {
      ok: false,
      failure: {
        status: 403,
        envelope: errorEnvelope({
          code: "confirmation_invalid",
          message: `Confirmation request rejected (${reason}).`,
        }),
      },
    };
  }

  return { ok: true, value: { ttlSeconds: Math.max(1, created.value.expiresAt - now) } };
}

/** Consume a verified durable proposal and translate store state to the wire contract. */
export async function consumeCapabilityApproval(options: {
  store: CapabilityApprovalStore;
  approvalId: string;
  capability: string;
  exposeErrors: boolean;
}): Promise<CapabilityApprovalTransition<null>> {
  const consumed = await withApprovalStore(options.capability, options.exposeErrors, () =>
    options.store.consume(options.approvalId),
  );
  if (!consumed.ok) return consumed;
  if (consumed.value.ok) return { ok: true, value: null };

  if (consumed.value.reason === "awaiting_approval") {
    return {
      ok: false,
      failure: {
        status: 409,
        envelope: errorEnvelope({
          code: "confirmation_pending",
          message: `Capability "${options.capability}" is awaiting human approval.`,
          approvalId: options.approvalId,
        }),
      },
    };
  }

  return {
    ok: false,
    failure: {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_invalid",
        message: `Confirmation token rejected (${consumed.value.reason}).`,
      }),
    },
  };
}

/** Approval backends fail closed and expose details only in debug mode. */
async function withApprovalStore<T>(
  capability: string,
  exposeErrors: boolean,
  operation: () => Promise<T>,
): Promise<CapabilityApprovalTransition<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    return {
      ok: false,
      failure: {
        status: 403,
        envelope: errorEnvelope({
          code: "confirmation_unavailable",
          message:
            `Destructive capability "${capability}" cannot run: the approval store failed` +
            (exposeErrors ? ` (${error instanceof Error ? error.message : String(error)}).` : "."),
        }),
      },
    };
  }
}
