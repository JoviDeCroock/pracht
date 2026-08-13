import { formatUnknownNameError } from "./name-suggestions.ts";
import { capabilityEnvelopeOutcome, emitCapabilityAudit } from "./runtime-capability-audit.ts";
import {
  createCapabilityPipelineContext,
  guardMcpCapabilityComposition,
  resolveCapabilityHostAgent,
} from "./runtime-capability-composition.ts";
import {
  CAPABILITY_TIMEOUT_MS,
  errorEnvelope,
  middlewareErrorCode,
  runCapabilityPipeline,
  type CapabilityPipelineOutcome,
} from "./runtime-capability-pipeline.ts";
import { resolveAppCapabilities } from "./runtime-capability-registry.ts";
import type {
  CapabilityHost,
  InvokeCapabilityContext,
} from "./runtime-capability-invocation-types.ts";
import type { CapabilityEnvelope } from "./types.ts";

/** Run one capability through the shared pipeline against an explicit host. */
export async function invokeCapabilityOnHost<T = unknown>(
  host: CapabilityHost,
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>> {
  const capabilities = await resolveAppCapabilities(host.app, host.registry);
  const resolved = capabilities.find((entry) => entry.name === name);
  if (!resolved) {
    return errorEnvelope({
      code: "unknown_capability",
      message: formatUnknownNameError({
        kind: "capability",
        kindPlural: "capabilities",
        name,
        registered: capabilities.map((entry) => entry.name),
      }),
    }) as CapabilityEnvelope<T>;
  }

  const started = performance.now();
  let context: unknown = ctx.context ?? {};
  let outcome: CapabilityPipelineOutcome;
  try {
    context = createCapabilityPipelineContext(host, ctx.context);
    outcome =
      guardMcpCapabilityComposition(host, resolved) ??
      (await runCapabilityPipeline({
        resolved,
        input,
        context,
        registry: host.registry,
        request: ctx.request,
        signal: ctx.signal ?? AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
        url: new URL(ctx.request.url),
        exposeErrors: true,
      }));
  } catch (error: unknown) {
    const envelope = errorEnvelope({
      code: "internal_error",
      message: `Capability "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    emitCapabilityAudit(
      {
        capability: name,
        effect: resolved.capability.effect,
        transport: "server",
        via: host.via ?? null,
        outcome: "internal_error",
        status: 500,
        durationMs: performance.now() - started,
        agent: resolveCapabilityHostAgent(host, context),
      },
      host.onAudit,
    );
    return envelope as CapabilityEnvelope<T>;
  }

  const agent = resolveCapabilityHostAgent(host, context);
  const status = outcome.kind === "envelope" ? outcome.status : outcome.response.status;
  const auditOutcome =
    outcome.kind === "envelope"
      ? capabilityEnvelopeOutcome(outcome.envelope)
      : `middleware_${status}`;
  emitCapabilityAudit(
    {
      capability: name,
      effect: resolved.capability.effect,
      transport: "server",
      via: host.via ?? null,
      outcome: auditOutcome,
      status,
      durationMs: performance.now() - started,
      agent,
    },
    host.onAudit,
  );

  if (outcome.kind === "envelope") return outcome.envelope as CapabilityEnvelope<T>;

  const code = middlewareErrorCode(status);
  return errorEnvelope({
    code,
    message: `Capability middleware short-circuited with status ${status}.`,
  }) as CapabilityEnvelope<T>;
}
