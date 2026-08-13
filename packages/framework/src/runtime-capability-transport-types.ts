import type { ResolvedCapability } from "./runtime-capability-registry.ts";
import type {
  CapabilityAuditHook,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
} from "./types.ts";

export interface HandleCapabilityRequestOptions<TContext> {
  match: ResolvedCapability;
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  url: URL;
  exposeErrors: boolean;
  /** App-level `api.middleware`, wrapped around the HTTP projection only. */
  apiMiddlewareFiles?: string[];
  /** App-level agent trust config (`defineApp({ agents })`). */
  agents?: PrachtAgentsConfig;
  /** Verified agent identity for this request, `null` when unsigned/unverified. */
  agent?: PrachtAgentIdentity | null;
  /** Trusted transport selected by an internal framework projection. */
  transport?: "mcp";
  onAudit?: CapabilityAuditHook;
}

export interface CapabilityDispatchResult {
  response: Response;
  outcome: string;
}
