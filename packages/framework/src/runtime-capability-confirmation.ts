/**
 * Destructive capability confirmation workflow.
 *
 * This module composes the low-level token primitives in
 * `runtime-confirmation.ts` with the durable approval policy in
 * `runtime-approval.ts`. Keeping that orchestration separate lets transports
 * opt into the same fail-closed prepare/commit gate without depending on the
 * capability HTTP adapter.
 */

import {
  capabilityApprovalId,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
} from "./runtime-approval.ts";
import {
  canonicalJson,
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  consumeConfirmationToken,
  createConfirmationToken,
  DEFAULT_CONFIRMATION_TTL_SECONDS,
  resolveConfirmationSecret,
  sha256Base64Url,
  verifyConfirmationToken,
} from "./runtime-confirmation.ts";
import { errorEnvelope } from "./runtime-capability-pipeline.ts";
import type { ResolvedCapability } from "./runtime-capability-registry.ts";
import type { CapabilityEnvelope, PrachtAgentIdentity, PrachtAgentsConfig } from "./types.ts";

export interface CapabilityConfirmationOptions<TContext> {
  match: ResolvedCapability;
  context: TContext;
  request: Request;
  exposeErrors: boolean;
  agents?: PrachtAgentsConfig;
  agent?: PrachtAgentIdentity | null;
}

/**
 * Prepare/commit gate for destructive capability calls. Returns the envelope
 * ending the request, or `null` when a valid confirmation token was presented
 * and the capability may run. Transports should install this as the pipeline's
 * `beforeRun` hook so named middleware observes prepare and invalid-token
 * attempts too.
 */
export async function enforceDestructiveConfirmation<TContext>(
  options: CapabilityConfirmationOptions<TContext>,
  validatedInput: unknown,
): Promise<{ status: number; envelope: CapabilityEnvelope } | null> {
  const secret = resolveConfirmationSecret();
  if (!secret) {
    // Exposed destructive capability without a configured secret: fail closed.
    // `pracht verify` reports this at build time too.
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${options.match.name}" cannot run: no confirmation ` +
          `secret is configured (set ${CONFIRMATION_SECRET_ENV}).`,
      }),
    };
  }

  const name = options.match.name;
  const store = resolveCapabilityApprovalStore();
  const mode = options.agents?.confirmation?.mode ?? "token";

  // A manifest asking for human approval without a store to hold proposals in
  // would silently degrade to self-approval. Fail closed and say why.
  if (mode === "human" && !store) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run: agents.confirmation.mode is ` +
          '"human" but no approval store is registered (call ' +
          "setCapabilityApprovalStore() from a server-only module).",
      }),
    };
  }

  let principal: string;
  let confirmationPrincipal: string;
  try {
    const resolvedPrincipal = await resolveCapabilityApprovalPrincipal({
      context: options.context,
      request: options.request,
      capability: name,
      agent: options.agent ?? null,
      confirmationSecret: secret,
    });
    principal = resolvedPrincipal?.record ?? "anonymous";
    confirmationPrincipal = resolvedPrincipal?.tokenBinding ?? "anonymous";
  } catch (error: unknown) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run: the approval principal resolver failed` +
          (options.exposeErrors
            ? ` (${error instanceof Error ? error.message : String(error)}).`
            : "."),
      }),
    };
  }
  if (mode === "human" && principal === "anonymous") {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run in human approval mode without an ` +
          "authenticated principal (use Web Bot Auth or call " +
          "setCapabilityApprovalPrincipalResolver() from a server-only module).",
      }),
    };
  }
  const canonicalInput = canonicalJson(validatedInput);
  const binding = {
    secret,
    principal: confirmationPrincipal,
    capability: name,
    canonicalInput,
    ...(store ? { approvalMode: mode } : {}),
  };
  const presented = options.request.headers.get(CONFIRMATION_HEADER);
  const ttlSeconds = options.agents?.confirmation?.ttlSeconds ?? DEFAULT_CONFIRMATION_TTL_SECONDS;

  // Proposal identity is derived from what the operation *is*, so repeated
  // prepares address one proposal instead of accumulating one per token.
  const inputHash = store ? await sha256Base64Url(canonicalInput) : null;
  const approvalId = inputHash
    ? await capabilityApprovalId(secret, principal, name, inputHash, mode)
    : null;

  if (!presented) {
    let expiresAtLimit = 0;
    if (store && approvalId && inputHash) {
      const now = Math.floor(Date.now() / 1000);
      const created = await withApprovalStore(name, options.exposeErrors, () =>
        store.create({
          id: approvalId,
          principal,
          capability: name,
          inputHash,
          input: validatedInput,
          requiresApproval: mode === "human",
          createdAt: now,
          expiresAt: now + ttlSeconds,
          state: "pending",
          decidedBy: null,
          decidedAt: null,
        }),
      );
      if (!created.ok) return created.failure;
      if (created.value.state === "consumed" || created.value.state === "rejected") {
        const reason = created.value.state === "consumed" ? "already_used" : "rejected";
        return {
          status: 403,
          envelope: errorEnvelope({
            code: "confirmation_invalid",
            message: `Confirmation request rejected (${reason}).`,
          }),
        };
      }
      // Re-preparing an existing proposal must not extend its life, so the
      // token expires with the proposal rather than `now + ttlSeconds`.
      expiresAtLimit = created.value.expiresAt - now;
    }

    const { token, expiresAt } = await createConfirmationToken({
      ...binding,
      ttlSeconds: store ? Math.max(1, expiresAtLimit) : ttlSeconds,
    });
    return {
      status: 409,
      envelope: errorEnvelope({
        code: "confirmation_required",
        message:
          mode === "human"
            ? `Capability "${name}" is destructive and needs human approval. Repeat the call ` +
              `with identical input and the "${CONFIRMATION_HEADER}" header once the proposal ` +
              "is approved."
            : `Capability "${name}" is destructive. Repeat the call with identical input and ` +
              `the "${CONFIRMATION_HEADER}" header set to the confirmation token.`,
        confirmationToken: token,
        expiresAt,
        ...(approvalId ? { approvalId } : {}),
      }),
    };
  }

  // Signature first, always: a forged or tampered token must never be able to
  // consume — and thereby destroy — a legitimate proposal.
  const verification = await verifyConfirmationToken(presented, binding);
  if (!verification.ok) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_invalid",
        message: `Confirmation token rejected (${verification.reason}).`,
      }),
    };
  }

  if (store && approvalId) {
    const consumed = await withApprovalStore(name, options.exposeErrors, () =>
      store.consume(approvalId),
    );
    if (!consumed.ok) return consumed.failure;

    if (!consumed.value.ok) {
      if (consumed.value.reason === "awaiting_approval") {
        return {
          status: 409,
          envelope: errorEnvelope({
            code: "confirmation_pending",
            message: `Capability "${name}" is awaiting human approval.`,
            approvalId,
          }),
        };
      }
      return {
        status: 403,
        envelope: errorEnvelope({
          code: "confirmation_invalid",
          message: `Confirmation token rejected (${consumed.value.reason}).`,
        }),
      };
    }
    return null;
  }

  if (
    options.agents?.confirmation?.singleUse &&
    !consumeConfirmationToken(verification.signature, verification.expiresAt)
  ) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_invalid",
        message: "Confirmation token rejected (already_used).",
      }),
    };
  }

  return null;
}

/**
 * Approval stores talk to a database, so they can fail. A store that is down
 * must never wave a destructive call through: any rejection becomes a closed
 * gate.
 */
async function withApprovalStore<T>(
  capability: string,
  exposeErrors: boolean,
  operation: () => Promise<T>,
): Promise<
  { ok: true; value: T } | { ok: false; failure: { status: number; envelope: CapabilityEnvelope } }
> {
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
