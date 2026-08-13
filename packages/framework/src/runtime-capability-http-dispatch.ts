import { coerceFormInput } from "@pracht/capabilities";

import { capabilityEnvelopeOutcome } from "./runtime-capability-audit.ts";
import { enforceDestructiveConfirmation } from "./runtime-capability-confirmation.ts";
import {
  CAPABILITY_TIMEOUT_MS,
  envelopeResponse,
  errorEnvelope,
  normalizeMiddlewareShortCircuit,
  runCapabilityPipeline,
} from "./runtime-capability-pipeline.ts";
import type {
  CapabilityDispatchResult,
  HandleCapabilityRequestOptions,
} from "./runtime-capability-transport-types.ts";

export async function dispatchCapabilityHttp<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<CapabilityDispatchResult> {
  const { capability, name } = options.match;

  if (options.request.method.toUpperCase() !== "POST") {
    return dispatched(
      envelopeResponse(
        405,
        errorEnvelope({
          code: "method_not_allowed",
          message: `Capability "${name}" only accepts POST.`,
        }),
      ),
      "method_not_allowed",
    );
  }

  // Web Bot Auth policy: per-capability override, then the app default.
  // "require" without a verified agent fails closed with the 401 envelope —
  // including when webBotAuth is not configured at all.
  const policy = capability.agentPolicy ?? options.agents?.webBotAuth?.policy ?? "observe";
  if (policy === "require" && !options.agent) {
    return dispatched(
      envelopeResponse(
        401,
        errorEnvelope({
          code: "agent_required",
          message: `Capability "${name}" requires a verified agent signature (Web Bot Auth).`,
        }),
      ),
      "agent_required",
    );
  }

  // JSON is the native encoding. Form posts — the no-JS fallback of
  // `<Form capability>` — are accepted too and coerced onto the input schema,
  // so progressive enhancement hits the exact same contract as agents do.
  let input: unknown = {};
  const contentType = options.request.headers.get("content-type") ?? "";
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");
  if (isFormPost) {
    try {
      const form = await options.request.formData();
      input = coerceFormInput(capability.input, form.entries());
    } catch {
      return dispatched(
        envelopeResponse(
          400,
          errorEnvelope({
            code: "invalid_json",
            message: "Request form body could not be parsed.",
          }),
        ),
        "invalid_json",
      );
    }
  } else {
    try {
      const body = await options.request.text();
      if (body.trim() !== "") input = JSON.parse(body);
    } catch {
      return dispatched(
        envelopeResponse(
          400,
          errorEnvelope({ code: "invalid_json", message: "Request body must be valid JSON." }),
        ),
        "invalid_json",
      );
    }
  }

  try {
    const beforeRun =
      capability.effect === "destructive"
        ? (validatedInput: unknown) => enforceDestructiveConfirmation(options, validatedInput)
        : undefined;

    const outcome = await runCapabilityPipeline({
      resolved: options.match,
      input,
      context: options.context,
      registry: options.registry,
      request: options.request,
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
      exposeErrors: options.exposeErrors,
      beforeRun,
    });

    if (outcome.kind === "envelope") {
      if (
        isFormPost &&
        outcome.envelope.ok &&
        (options.request.headers.get("accept") ?? "").includes("text/html")
      ) {
        const back = sameOriginReferer(options.request, options.url);
        if (back) return dispatched(Response.redirect(back, 303), "ok");
      }
      return dispatched(outcome.response, capabilityEnvelopeOutcome(outcome.envelope));
    }
    const normalized = normalizeMiddlewareShortCircuit(outcome.response);
    return dispatched(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return dispatched(capabilityInternalErrorResponse(options, error), "internal_error");
  }
}

export function capabilityInternalErrorResponse<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  error: unknown,
): Response {
  return envelopeResponse(
    500,
    errorEnvelope({
      code: "internal_error",
      message: options.exposeErrors
        ? `Capability "${options.match.name}" failed: ${error instanceof Error ? error.message : String(error)}`
        : "Capability failed.",
    }),
  );
}

function dispatched(response: Response, outcome: string): CapabilityDispatchResult {
  return { response, outcome };
}

function sameOriginReferer(request: Request, url: URL): string | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    return parsed.origin === url.origin ? parsed.href : null;
  } catch {
    return null;
  }
}
