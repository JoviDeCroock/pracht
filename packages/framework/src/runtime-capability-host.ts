import { snapshotAgentIdentity } from "./runtime-agent-context.ts";
import type { CapabilityHostApp } from "./runtime-capability-registry.ts";
import type { CapabilityHost } from "./runtime-capability-invocation-types.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  ModuleRegistry,
  PrachtAgentIdentity,
} from "./types.ts";

// Bind each host to the incoming Request rather than a process-global slot.
// A WeakMap isolates overlapping apps, registries, and requests without
// retaining completed requests.
const activeCapabilityHosts = new WeakMap<Request, CapabilityHost>();

export function setActiveCapabilityHost(
  request: Request,
  app: CapabilityHostApp,
  registry: ModuleRegistry,
  /** Transport of the request being served; audits nested composition. */
  via: NonNullable<CapabilityAuditEvent["via"]> = "http",
  onAudit?: CapabilityAuditHook,
  agent?: PrachtAgentIdentity | null,
): void {
  activeCapabilityHosts.set(request, {
    app,
    registry,
    via,
    onAudit,
    agent: snapshotAgentIdentity(agent ?? null),
  });
}

export function getActiveCapabilityHost(request: Request): CapabilityHost | undefined {
  return activeCapabilityHosts.get(request);
}
