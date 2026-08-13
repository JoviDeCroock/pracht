import { bindAgentContext } from "./runtime-agent-context.ts";
import {
  envelopeResponse,
  errorEnvelope,
  type CapabilityPipelineOutcome,
} from "./runtime-capability-pipeline.ts";
import type { ResolvedCapability } from "./runtime-capability-registry.ts";
import type { CapabilityHost } from "./runtime-capability-invocation-types.ts";
import type { PrachtAgentIdentity, PrachtContextExtensions } from "./types.ts";

/** Enforce remote-MCP identity and effect boundaries before nested middleware runs. */
export function guardMcpCapabilityComposition(
  host: CapabilityHost,
  resolved: ResolvedCapability,
): CapabilityPipelineOutcome | null {
  if (host.via !== "mcp") return null;

  const policy =
    resolved.capability.agentPolicy ?? host.app.agents?.webBotAuth?.policy ?? "observe";
  if (policy === "require" && !host.agent) {
    const envelope = errorEnvelope({
      code: "agent_required",
      message: `Capability "${resolved.name}" requires a verified agent signature (Web Bot Auth).`,
    });
    return { kind: "envelope", status: 401, envelope, response: envelopeResponse(401, envelope) };
  }

  if (resolved.capability.effect === "destructive") {
    const envelope = errorEnvelope({
      code: "forbidden",
      message: `Capability "${resolved.name}" cannot be composed from remote MCP because it is destructive.`,
    });
    return { kind: "envelope", status: 403, envelope, response: envelopeResponse(403, envelope) };
  }

  return null;
}

/** Bind the trusted transport identity without mutating an application context. */
export function createCapabilityPipelineContext<TContext>(
  host: CapabilityHost,
  supplied: TContext | undefined,
): TContext | PrachtContextExtensions {
  const context = supplied ?? {};
  const carriesTransportIdentity =
    !!host.app.agents?.webBotAuth && (host.via === "http" || host.via === "mcp");
  if (!carriesTransportIdentity) return context;
  return bindAgentContext(context, host.agent ?? null);
}

export function resolveCapabilityHostAgent<TContext>(
  host: CapabilityHost,
  context: TContext,
): PrachtAgentIdentity | null {
  return host.via === "http" || host.via === "mcp"
    ? (host.agent ?? null)
    : ((context as { agent?: PrachtAgentIdentity | null }).agent ?? null);
}
