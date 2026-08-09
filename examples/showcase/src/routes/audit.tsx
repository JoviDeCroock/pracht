import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { readAudit } from "../server/audit.ts";

/**
 * Every capability dispatch emits one structured event, whatever called it.
 * `setCapabilityAuditHook()` in src/server/agent-runtime.ts collects them; this
 * page renders the last 50.
 *
 * The `transport` column is the interesting one: `server` is a loader calling
 * `invokeCapability()`, `http` is a browser fetch or a remote agent, and
 * `webmcp` is the marker the in-page WebMCP shim sends. That marker is
 * client-declared and therefore informational, not a trust signal — the
 * `agent` column is the one that is cryptographically verified.
 */
export async function loader(_args: LoaderArgs) {
  const now = Date.now();
  return {
    events: readAudit().map((event) => ({
      capability: event.capability,
      effect: event.effect,
      transport: event.transport,
      outcome: event.outcome,
      status: event.status,
      durationMs: Math.round(event.durationMs),
      agent: event.agent ? (event.agent.agentDomain ?? event.agent.keyId) : null,
      ago: Math.max(0, Math.round((now - event.at) / 1000)),
    })),
  };
}

export function head() {
  return { title: "Audit — Launchpad" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="audit">
      <header class="page-head">
        <div>
          <p class="eyebrow">Every dispatch, one event</p>
          <h1>Capability audit trail</h1>
          <p class="page-sub">
            One event per dispatch — browser fetch, progressively-enhanced form post, in-page WebMCP
            tool call, signed remote agent, or a loader's own server-side invocation. Audit hooks
            observe: an exception in one is swallowed rather than breaking the request.
          </p>
        </div>
      </header>

      {data.events.length === 0 ? (
        <div class="empty-state">
          <p>No dispatches recorded on this instance yet.</p>
          <p class="page-sub">
            Call something from the <a href="/playground">playground</a> and come back.
          </p>
        </div>
      ) : (
        <div class="audit-table-wrap">
          <table class="audit-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Effect</th>
                <th>Transport</th>
                <th>Outcome</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Latency</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event, index) => (
                <tr key={`${event.capability}-${index}`}>
                  <td>
                    <code>{event.capability}</code>
                  </td>
                  <td>
                    <span class={`effect-tag ${event.effect}`}>{event.effect}</span>
                  </td>
                  <td>
                    <span class="transport-tag">{event.transport}</span>
                  </td>
                  <td class={event.outcome === "ok" ? "outcome-ok" : "outcome-bad"}>
                    {event.outcome}
                  </td>
                  <td>{event.status}</td>
                  <td>{event.agent ? <code>{event.agent}</code> : <span class="dim">—</span>}</td>
                  <td>{event.durationMs} ms</td>
                  <td class="dim">{event.ago}s ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
