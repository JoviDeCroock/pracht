import type { CapabilityAuditEvent } from "@pracht/core";

/**
 * Every capability dispatch — browser fetch, `<Form capability>` post, WebMCP
 * tool call, remote HTTP agent, or a loader's own `invokeCapability()` — emits
 * one structured event. The showcase keeps the last 50 in a ring buffer and
 * renders them at /app/audit, so you can watch who called what.
 */

export interface AuditEntry extends CapabilityAuditEvent {
  at: number;
}

const LIMIT = 50;
let entries: AuditEntry[] = [];

export function recordAudit(event: CapabilityAuditEvent): void {
  entries = [{ ...event, at: Date.now() }, ...entries].slice(0, LIMIT);
}

export function readAudit(): AuditEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearAudit(): void {
  entries = [];
}
