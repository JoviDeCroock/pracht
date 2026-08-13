import type { CapabilityHostApp } from "./runtime-capability-registry.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  ModuleRegistry,
  PrachtAgentIdentity,
} from "./types.ts";

export interface CapabilityHost {
  app: CapabilityHostApp;
  registry: ModuleRegistry;
  /** Request-local audit hook supplied by a custom server entry. */
  onAudit?: CapabilityAuditHook;
  /** Verified identity bound by a trusted transport, never caller-supplied context. */
  agent?: PrachtAgentIdentity | null;
  /** Transport that caused nested server composition for audit attribution. */
  via?: CapabilityAuditEvent["via"];
}

export interface InvokeCapabilityContext<TContext = unknown> {
  /** The incoming request — middleware and `run()` receive it. */
  request: Request;
  context?: TContext;
  signal?: AbortSignal;
}
