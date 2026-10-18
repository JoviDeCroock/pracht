import { mcpToolServing } from "@pracht/capabilities";
import type { AppGraphCapability } from "@pracht/core";

/** The MCP endpoint facts the exposure column needs, as the app graph reports them. */
export interface McpExposureContext {
  mcpEndpoint?: string | null;
  mcpDestructive?: boolean;
  mcpAuthenticated?: boolean;
  mcpRuntimeStatus?: "blocked" | "not-configured" | "ready" | "unverified";
}

/**
 * The EXPOSURE column the dev banner and `pracht inspect` print. `mcp` reads
 * `mcp(unserved)` whenever the runtime would not serve the tool (the rule is
 * `mcpToolServing` from `@pracht/capabilities`, shared with the endpoint) or
 * the endpoint is blocked, and `mcp(unverified)` when graph-only inspection
 * could not check the endpoint's preconditions.
 */
export function formatCapabilityTransports(
  capability: Pick<AppGraphCapability, "effect" | "mcpScopes" | "transports">,
  context: McpExposureContext,
): string {
  if (capability.transports.length === 0) return "private";
  return capability.transports
    .map((transport) => {
      if (transport !== "mcp") return transport;
      const serving = mcpToolServing(
        { effect: capability.effect, mcp: true, mcpScopes: capability.mcpScopes },
        {
          endpoint: !!context.mcpEndpoint,
          // The graph reports `mcpDestructive` only when a destructive tool is
          // served, which is exactly when the opt-in is on for this tool.
          destructive: context.mcpDestructive === true,
          auth: context.mcpAuthenticated === true,
        },
      );
      if (serving !== "served" || context.mcpRuntimeStatus === "blocked") return "mcp(unserved)";
      return context.mcpRuntimeStatus === "unverified" ? "mcp(unverified)" : transport;
    })
    .join(",");
}
