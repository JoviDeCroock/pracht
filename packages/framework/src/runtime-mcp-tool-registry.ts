import {
  findMcpToolNameCollisions,
  isValidMcpToolName,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
} from "@pracht/capabilities";

import type { ResolvedCapability } from "./runtime-capabilities.ts";
import { mcpExposedCapabilities } from "./runtime-mcp-tools.ts";

export type McpToolRegistry =
  | { ok: true; capabilities: ResolvedCapability[] }
  | { ok: false; message: string };

/** Validate the projected tool namespace before serving any MCP method. */
export function validateMcpToolRegistry(
  capabilities: readonly ResolvedCapability[],
): McpToolRegistry {
  const exposed = mcpExposedCapabilities(capabilities);
  const invalidToolNames = exposed.filter((entry) => !isValidMcpToolName(mcpToolName(entry.name)));
  if (invalidToolNames.length > 0) {
    return {
      ok: false,
      message:
        `${MCP_TOOL_NAME_ERROR}: ` +
        invalidToolNames.map((entry) => `${entry.name} → ${mcpToolName(entry.name)}`).join("; "),
    };
  }

  const collisions = findMcpToolNameCollisions(exposed.map((entry) => entry.name));
  if (collisions.length > 0) {
    return {
      ok: false,
      message:
        "Capability names collide as MCP tool names: " +
        collisions
          .map((collision) => `${collision.capabilities.join(" / ")} → ${collision.toolName}`)
          .join("; "),
    };
  }

  return { ok: true, capabilities: exposed };
}
