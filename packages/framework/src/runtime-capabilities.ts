/** Stable public facade and audit orchestrator for capability HTTP transport. */

import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_HTTP_PREFIX,
  CAPABILITY_TRANSPORT_HEADER,
  capabilityHttpPath,
} from "@pracht/capabilities";

import { emitCapabilityAudit } from "./runtime-capability-audit.ts";
import { dispatchCapabilityHttpWithApiMiddleware } from "./runtime-capability-api-middleware.ts";
import { revalidateMcpSuccessEnvelope } from "./runtime-capability-mcp-output.ts";
import type { HandleCapabilityRequestOptions } from "./runtime-capability-transport-types.ts";
import type { CapabilityAuditEvent } from "./types.ts";

export { CAPABILITY_HTTP_PREFIX, capabilityHttpPath };
export { setCapabilityAuditHook } from "./runtime-capability-audit.ts";
export { envelopeResponse } from "./runtime-capability-pipeline.ts";
export {
  invokeCapability,
  invokeCapabilityOnHost,
  setActiveCapabilityHost,
} from "./runtime-capability-invocation.ts";
export type { CapabilityHost, InvokeCapabilityContext } from "./runtime-capability-invocation.ts";
export {
  isRegisteredCapabilityHttpPath,
  matchCapabilityRoute,
  resolveAppCapabilities,
} from "./runtime-capability-registry.ts";
export type { CapabilityHostApp, ResolvedCapability } from "./runtime-capability-registry.ts";
export type { HandleCapabilityRequestOptions } from "./runtime-capability-transport-types.ts";

export async function handleCapabilityRequest<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<Response> {
  const started = performance.now();
  let dispatched = await dispatchCapabilityHttpWithApiMiddleware(options);
  if (options.transport === "mcp") {
    dispatched = await revalidateMcpSuccessEnvelope(options, dispatched);
  }
  const { response, outcome } = dispatched;
  const responseWithEffect = withCapabilityEffect(response, options.match.capability.effect);
  emitCapabilityAudit(
    {
      capability: options.match.name,
      effect: options.match.capability.effect,
      transport: capabilityTransport(
        options.request.headers.get(CAPABILITY_TRANSPORT_HEADER),
        options.transport,
      ),
      via: null,
      outcome,
      status: responseWithEffect.status,
      durationMs: performance.now() - started,
      agent: options.agent ?? null,
    },
    options.onAudit,
  );
  return responseWithEffect;
}

function capabilityTransport(
  marker: string | null,
  trustedTransport: HandleCapabilityRequestOptions<unknown>["transport"],
): CapabilityAuditEvent["transport"] {
  if (trustedTransport === "mcp") return "mcp";
  if (marker === "webmcp") return "webmcp";
  return "http";
}

function withCapabilityEffect(response: Response, effect: string): Response {
  const headers = new Headers(response.headers);
  headers.set(CAPABILITY_EFFECT_HEADER, effect);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
