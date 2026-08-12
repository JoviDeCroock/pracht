import { mcpToolName } from "@pracht/capabilities";

import type { ResolvedCapability } from "./runtime-capabilities.ts";
import type { CapabilityEnvelope } from "./types.ts";

/** Project a resolved capability into the MCP tools/list descriptor shape. */
export function createMcpToolDescriptor(entry: ResolvedCapability) {
  const { capability } = entry;
  return {
    name: mcpToolName(entry.name),
    title: capability.title,
    description: capability.description,
    inputSchema: capability.input,
    outputSchema: capability.output,
    // UX hints only; capability effect enforcement remains server-side.
    annotations: {
      readOnlyHint: capability.effect === "read",
      ...(capability.effect === "read" ? { destructiveHint: false } : {}),
      idempotentHint: capability.effect === "read",
    },
    _meta: { "io.pracht/capability": entry.name, "io.pracht/effect": capability.effect },
  };
}

/**
 * Convert a capability envelope to an MCP tool result. Execution failures are
 * tool errors rather than JSON-RPC errors so the model can inspect and react.
 */
export function createMcpToolResult(
  match: ResolvedCapability,
  envelope: CapabilityEnvelope,
  status: number,
) {
  if (envelope.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(envelope.data, null, 2) }],
      structuredContent: envelope.data,
      isError: false,
      _meta: { "io.pracht/capability": match.name },
    };
  }

  const { error } = envelope;
  const lines = [`${error.code}: ${error.message}`];
  if (error.issues?.length) {
    lines.push(...error.issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
    _meta: {
      "io.pracht/capability": match.name,
      "io.pracht/status": status,
      "io.pracht/error": {
        code: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      },
    },
  };
}

/** Validate middleware output before exposing it as structured MCP content. */
export function isCapabilityEnvelope(value: unknown): value is CapabilityEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapabilityEnvelope>;
  if (candidate.ok === true) return "data" in candidate;
  if (candidate.ok !== false || !candidate.error || typeof candidate.error !== "object") {
    return false;
  }
  if (typeof candidate.error.code !== "string" || typeof candidate.error.message !== "string") {
    return false;
  }
  return (
    candidate.error.issues === undefined ||
    (Array.isArray(candidate.error.issues) &&
      candidate.error.issues.every(
        (issue) => !!issue && typeof issue.path === "string" && typeof issue.message === "string",
      ))
  );
}
