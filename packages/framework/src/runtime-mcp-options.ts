import type { CapabilityHostApp, ResolvedCapability } from "./runtime-capabilities.ts";
import type {
  CapabilityAuditHook,
  McpProjectionConfig,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
} from "./types.ts";

/** Complete immutable context for one stateless MCP request. */
export interface HandleMcpRequestOptions<TContext> {
  app: CapabilityHostApp;
  capabilities: readonly ResolvedCapability[];
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  url: URL;
  exposeErrors: boolean;
  mcp: McpProjectionConfig;
  agents?: PrachtAgentsConfig;
  agent?: PrachtAgentIdentity | null;
  apiMiddlewareFiles?: string[];
  onAudit?: CapabilityAuditHook;
  /** Registry resolution failure captured by the outer application runtime. */
  resolutionError?: unknown;
}
