import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { approvalStore } from "../server/agent-runtime.ts";

/**
 * The human half of `confirmation: { mode: "human" }`.
 *
 * A proposal's id is a secret-keyed digest of the principal, the capability
 * name, the canonicalized input, and the mode — never supplied by a caller —
 * so repeated prepares for the same operation address one proposal. A person
 * approves an *action*, not one particular token.
 */
export async function loader(_args: LoaderArgs) {
  const pending = await approvalStore.listPending();
  const now = Math.floor(Date.now() / 1000);

  return {
    now,
    pending: pending.map((record) => ({
      id: record.id,
      capability: record.capability,
      // The framework records a JSON array when more than one identity binds a
      // proposal (a verified agent *and* the application principal).
      principal: formatPrincipal(record.principal),
      input: JSON.stringify(record.input, null, 2),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      secondsLeft: Math.max(0, record.expiresAt - now),
    })),
  };
}

function formatPrincipal(principal: string): string {
  try {
    const parsed: unknown = JSON.parse(principal);
    if (Array.isArray(parsed)) return parsed.join(" + ");
  } catch {
    // Not JSON — a single principal string.
  }
  return principal;
}

export function head() {
  return { title: "Approvals — Launchpad" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="approvals">
      <header class="page-head">
        <div>
          <p class="eyebrow">Durable approval store</p>
          <h1>Approval inbox</h1>
          <p class="page-sub">
            Pracht ships no approval endpoint and no approval UI on purpose — who may approve is an
            application decision, and a framework default would be the same mistake as trusting a
            host's "the user said yes". This page is the application's answer, behind its own
            session check.
          </p>
        </div>
      </header>

      {data.pending.length === 0 ? (
        <div class="empty-state">
          <p>Nothing waiting.</p>
          <p class="page-sub">
            Request an archive from the <a href="/app">dashboard</a> or the{" "}
            <a href="/playground">playground</a>, or run <code>node scripts/agent.mjs</code> to have
            a signed agent propose one.
          </p>
        </div>
      ) : (
        <ul class="approval-list">
          {data.pending.map((record) => (
            <li key={record.id} class="approval-card">
              <div class="approval-head">
                <div>
                  <code class="capability-name">{record.capability}</code>
                  <span class="effect-tag destructive">destructive</span>
                </div>
                <span class="approval-expiry">expires in {record.secondsLeft}s</span>
              </div>

              <dl class="approval-meta">
                <dt>Proposed by</dt>
                <dd>
                  <code>{record.principal}</code>
                </dd>
                <dt>Proposal id</dt>
                <dd>
                  <code class="wrap">{record.id}</code>
                </dd>
              </dl>

              <pre class="approval-input">
                <code>{record.input}</code>
              </pre>

              {/*
                A plain form: this page needs no JavaScript to work, and the
                decision is recorded by the application, not reported by the
                caller.
              */}
              <div class="approval-actions">
                <form method="post" action="/api/admin/approvals">
                  <input type="hidden" name="id" value={record.id} />
                  <input type="hidden" name="decision" value="approved" />
                  <button type="submit" class="btn-approve">
                    Approve
                  </button>
                </form>
                <form method="post" action="/api/admin/approvals">
                  <input type="hidden" name="id" value={record.id} />
                  <input type="hidden" name="decision" value="rejected" />
                  <button type="submit" class="btn-reject">
                    Reject
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p class="footnote">
        Consumed and rejected proposals stay closed until they expire, so an old still-valid token
        cannot become reusable. <code>consume()</code> is a compare-and-set: two replicas committing
        concurrently produce exactly one success.
      </p>
    </section>
  );
}
