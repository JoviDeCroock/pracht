import { useState } from "preact/hooks";
import { callCapability } from "virtual:pracht/capabilities";

/**
 * The destructive prepare/commit flow, written out.
 *
 * The generated types force this shape: `callCapability("projects.archive", …)`
 * does not compile without exactly one of `{ prepare: true }` or `{ confirm }`,
 * so a call site cannot forget the gate and discover it as a 409 in production.
 *
 * Because the app runs `confirmation: { mode: "human" }`, the commit is refused
 * with `confirmation_pending` until a reviewer decides at /app/approvals. The
 * caller just retries the same token — approval is not something it can grant
 * itself.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "pending"; token: string; approvalId?: string; note: string }
  | { kind: "done"; name: string }
  | { kind: "error"; message: string };

export function ArchiveFlow({ projectId, name }: { projectId: string; name: string }) {
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const input = reason.trim() ? { projectId, reason: reason.trim() } : { projectId };

  async function prepare() {
    setPhase({ kind: "working" });
    // Phase 1: no token on the wire. The server mints one bound to the
    // principal, the capability name, and a hash of this exact input.
    const prepared = await callCapability("projects.archive", input, { prepare: true });

    if (prepared.ok) {
      setPhase({ kind: "done", name });
      return;
    }
    if (prepared.error.code === "confirmation_required" && prepared.error.confirmationToken) {
      setPhase({
        kind: "pending",
        token: prepared.error.confirmationToken,
        approvalId: prepared.error.approvalId,
        note: "Proposal opened. A reviewer has to approve it before the commit runs.",
      });
      return;
    }
    setPhase({ kind: "error", message: describe(prepared.error.code, prepared.error.message) });
  }

  async function commit(token: string, approvalId?: string) {
    setPhase({ kind: "working" });
    // Phase 2: byte-identical input plus the token. The server re-derives the
    // binding, verifies the HMAC, then consumes the proposal exactly once.
    const committed = await callCapability("projects.archive", input, { confirm: token });

    if (committed.ok) {
      setPhase({ kind: "done", name: committed.data.name ?? name });
      return;
    }
    if (committed.error.code === "confirmation_pending") {
      setPhase({
        kind: "pending",
        token,
        approvalId: committed.error.approvalId ?? approvalId,
        note: "Still awaiting a decision. Approve it in the inbox, then commit again.",
      });
      return;
    }
    setPhase({ kind: "error", message: describe(committed.error.code, committed.error.message) });
  }

  if (phase.kind === "done") {
    return (
      <p class="flow-result flow-ok">
        Archived <strong>{phase.name}</strong>. The proposal is consumed — the same token cannot run
        it twice.
      </p>
    );
  }

  return (
    <div class="archive-flow">
      <div class="archive-flow-row">
        <input
          type="text"
          placeholder="Reason (shown to the reviewer)"
          value={reason}
          disabled={phase.kind !== "idle"}
          onInput={(event) => setReason((event.target as HTMLInputElement).value)}
        />
        {phase.kind === "pending" ? (
          <button
            type="button"
            class="btn-danger"
            onClick={() => commit(phase.token, phase.approvalId)}
          >
            Commit archive
          </button>
        ) : (
          <button
            type="button"
            class="btn-danger"
            disabled={phase.kind === "working"}
            onClick={prepare}
          >
            {phase.kind === "working" ? "Working…" : "Request archive"}
          </button>
        )}
      </div>

      {phase.kind === "pending" ? (
        <p class="flow-result flow-pending">
          {phase.note} <a href="/app/approvals">Open the approval inbox &rarr;</a>
          {phase.approvalId ? <code class="flow-id">{phase.approvalId.slice(0, 12)}…</code> : null}
        </p>
      ) : null}

      {phase.kind === "error" ? <p class="flow-result flow-error">{phase.message}</p> : null}
    </div>
  );
}

function describe(code: string, message: string): string {
  if (code === "confirmation_unavailable") {
    return "Fails closed: destructive calls need an approval store and an authenticated principal. Sign in first.";
  }
  if (code === "confirmation_invalid") {
    return "Token rejected — it was tampered with, expired, or bound to different input.";
  }
  return `${code}: ${message}`;
}
