/**
 * Dev-only ring buffer of capability audit events, rendered as the "Agents"
 * section of `/_pracht` and the `agentTraffic` field of `/_pracht.json`.
 *
 * Lives in the vite plugin rather than the runtime on purpose: it is fed from
 * the dev SSR middleware's `onCapabilityAudit` option, so no production
 * adapter, bundle, or endpoint can reach it. One buffer per dev server, bounded
 * so a long-running dev session cannot grow without limit.
 */

import type { AgentTrafficEvent, DevtoolsAgentTraffic } from "@pracht/core/devtools";

/**
 * Ring-buffer capacity. Large enough to cover a debugging session's worth of
 * agent calls, small enough that a dev server left running for days holds a
 * bounded amount of memory.
 */
export const AGENT_TRAFFIC_LIMIT = 200;

/** The subset of `CapabilityAuditEvent` the buffer reads. */
interface AuditEventLike {
  capability: string;
  effect: string;
  transport: string;
  via: string | null;
  outcome: string;
  status: number;
  durationMs: number;
  tokenAuth?: { subject: string; clientId?: string | null } | null;
  agent: { agentDomain: string | null; keyId: string } | null;
}

export interface AgentTrafficBuffer {
  /** Record one dispatch. Never throws — it runs inside the audit hook. */
  record(event: AuditEventLike): void;
  /** Newest-first snapshot plus the totals the panel reports. */
  snapshot(): DevtoolsAgentTraffic;
}

export function createAgentTrafficBuffer(limit: number = AGENT_TRAFFIC_LIMIT): AgentTrafficBuffer {
  // A capacity below 1 would make `record` a no-op that still counts, which
  // reads as a bug in the panel. Clamp instead.
  const capacity = Math.max(1, Math.floor(limit));
  // Oldest first; `snapshot()` reverses. Shifting a bounded array is cheap
  // enough at this size and keeps the structure obvious.
  const events: AgentTrafficEvent[] = [];
  let recorded = 0;

  return {
    record(event: AuditEventLike): void {
      recorded += 1;
      events.push({
        at: Date.now(),
        capability: event.capability,
        effect: event.effect,
        transport: event.transport,
        via: event.via,
        outcome: event.outcome,
        status: event.status,
        durationMs: event.durationMs,
        tokenAuth: event.tokenAuth
          ? { subject: event.tokenAuth.subject, clientId: event.tokenAuth.clientId ?? null }
          : null,
        // Copied rather than referenced: the audit event's frozen identity is
        // request-scoped, and the panel outlives the request.
        agent: event.agent
          ? { agentDomain: event.agent.agentDomain, keyId: event.agent.keyId }
          : null,
      });
      while (events.length > capacity) events.shift();
    },
    snapshot(): DevtoolsAgentTraffic {
      return { limit: capacity, recorded, events: [...events].reverse() };
    },
  };
}
