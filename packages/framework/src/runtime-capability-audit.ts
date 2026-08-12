/** Capability audit observer registration and fail-safe event delivery. */

import { snapshotAgentIdentity } from "./runtime-agent-context.ts";
import type { CapabilityAuditEvent, CapabilityAuditHook } from "./types.ts";

// Module-level hook so server-only application code can subscribe without
// passing functions through the serializable app manifest.
let capabilityAuditHook: CapabilityAuditHook | null = null;

export function setCapabilityAuditHook(hook: CapabilityAuditHook | null): void {
  capabilityAuditHook = hook;
}

/** Audit hooks observe; they must never break a request. */
export function emitCapabilityAudit(
  event: CapabilityAuditEvent,
  extra?: CapabilityAuditHook,
): void {
  const snapshot = Object.freeze({
    ...event,
    agent: snapshotAgentIdentity(event.agent),
  });
  for (const hook of [capabilityAuditHook, extra]) {
    if (!hook) continue;
    try {
      hook(snapshot);
    } catch {
      // Deliberately swallowed.
    }
  }
}
