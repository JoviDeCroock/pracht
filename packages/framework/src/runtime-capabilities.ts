/**
 * Capability HTTP transport.
 *
 * Capabilities are registered in the app manifest (like shells/middleware)
 * and executed through one pipeline regardless of how they are invoked:
 *
 *   input validation → named middleware chain → run() → output validation
 *
 * Both the generated HTTP projection (`handlePrachtRequest`) and direct
 * server-side use (`invokeCapability`) call the same pipeline, so business
 * rules can never diverge between transports. Capabilities are private by
 * default — only `expose.http` makes one reachable over the network.
 */

import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_HTTP_PREFIX,
  CAPABILITY_TRANSPORT_HEADER,
  capabilityHttpPath,
  coerceFormInput,
} from "@pracht/capabilities";
import { capabilityEnvelopeOutcome, emitCapabilityAudit } from "./runtime-capability-audit.ts";
import { enforceDestructiveConfirmation } from "./runtime-capability-confirmation.ts";
import {
  capabilityMiddlewareRoute,
  CAPABILITY_TIMEOUT_MS,
  envelopeResponse,
  errorEnvelope,
  normalizeMiddlewareShortCircuit,
  runCapabilityPipeline,
} from "./runtime-capability-pipeline.ts";
import type { ResolvedCapability } from "./runtime-capability-registry.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
} from "./types.ts";

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

/**
 * Handle a matched capability HTTP request. Method/CSRF checks already ran in
 * `handlePrachtRequest`. Always answers with the typed envelope, except for
 * middleware redirects (3xx pass through untouched). Emits one audit event
 * per dispatch (principal, capability, effect, outcome, duration).
 */
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
      // MCP is trusted internal dispatch state. WebMCP remains a
      // client-declared marker and is therefore informational only.
      transport: capabilityTransport(
        options.request.headers.get(CAPABILITY_TRANSPORT_HEADER),
        options.transport,
      ),
      // A dispatch that arrived on a transport is not composed under one.
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

/**
 * MCP advertises the capability's output schema in `tools/list`. Middleware
 * can short-circuit with its own success envelope before the capability
 * pipeline validates output, so validate that envelope before the audit event
 * and status are finalized. The MCP adapter can then translate the same
 * settled response without making its audit trail disagree with the client.
 */
async function revalidateMcpSuccessEnvelope<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  dispatched: { response: Response; outcome: string },
): Promise<{ response: Response; outcome: string }> {
  if (!dispatched.outcome.startsWith("middleware_")) return dispatched;

  let parsed: unknown;
  try {
    parsed = await dispatched.response.clone().json();
  } catch {
    return dispatched;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { ok?: unknown }).ok !== true ||
    !("data" in parsed)
  ) {
    return dispatched;
  }

  const validatedOutput = options.match.capability.validateOutput(
    (parsed as { data: unknown }).data,
  );
  const headers = new Headers(dispatched.response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  if (validatedOutput.ok) {
    return {
      response: new Response(JSON.stringify({ ok: true, data: validatedOutput.value }), {
        status: dispatched.response.status,
        headers,
      }),
      outcome: dispatched.outcome,
    };
  }

  return audited(
    new Response(
      JSON.stringify(
        errorEnvelope({
          code: "invalid_output",
          message: options.exposeErrors
            ? `Capability "${options.match.name}" produced output that does not match its output schema.`
            : "Capability failed.",
          issues: options.exposeErrors ? validatedOutput.issues : undefined,
        }),
      ),
      { status: 500, headers },
    ),
    "invalid_output",
  );
}

/**
 * Capability endpoints are part of the application's HTTP API surface, so the
 * app-level API middleware chain wraps the complete dispatch. This deliberately
 * stays outside `runCapabilityPipeline`: direct server invocation should run
 * capability middleware, but must not inherit HTTP-only API policy.
 */
async function dispatchCapabilityHttpWithApiMiddleware<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<{ response: Response; outcome: string }> {
  const middlewareFiles = options.apiMiddlewareFiles ?? [];
  if (middlewareFiles.length === 0) {
    return dispatchCapabilityHttp(options);
  }

  // Holder object because the value is assigned inside the terminal closure;
  // TypeScript does not carry that assignment into the outer control flow.
  const holder: { dispatched: { response: Response; outcome: string } | null } = {
    dispatched: null,
  };
  try {
    const response = await runMiddlewareChain({
      context: options.context,
      middlewareFiles,
      params: {},
      registry: options.registry,
      request: options.request,
      route: capabilityMiddlewareRoute(options.match),
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
      terminal: async () => {
        holder.dispatched = await dispatchCapabilityHttp(options);
        return holder.dispatched.response;
      },
    });

    const dispatched = holder.dispatched;
    if (dispatched && response === dispatched.response) {
      return dispatched;
    }

    const normalized = normalizeMiddlewareShortCircuit(response);
    return audited(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return audited(capabilityInternalErrorResponse(options, error), "internal_error");
  }
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

async function dispatchCapabilityHttp<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<{ response: Response; outcome: string }> {
  const { capability, name } = options.match;

  if (options.request.method.toUpperCase() !== "POST") {
    return audited(
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
    return audited(
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
      return audited(
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
      if (body.trim() !== "") {
        input = JSON.parse(body);
      }
    } catch {
      return audited(
        envelopeResponse(
          400,
          errorEnvelope({ code: "invalid_json", message: "Request body must be valid JSON." }),
        ),
        "invalid_json",
      );
    }
  }

  try {
    // Destructive capabilities never run on the first call: the prepare/commit
    // confirmation gate answers unless a valid token for this exact principal +
    // input is presented. It runs as the pipeline's `beforeRun` hook — after
    // named middleware — so rate-limiting middleware sees prepare and
    // invalid-token attempts too. Invalid input still yields the usual 400 with
    // issues because the pipeline validates before reaching the hook.
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
      // Progressive enhancement: a successful form post from a document (the
      // no-JS `<Form capability>` fallback) navigates back to the page it
      // was posted from instead of rendering the JSON envelope.
      if (
        isFormPost &&
        outcome.envelope.ok &&
        (options.request.headers.get("accept") ?? "").includes("text/html")
      ) {
        const back = sameOriginReferer(options.request, options.url);
        if (back) {
          return audited(Response.redirect(back, 303), "ok");
        }
      }
      return audited(outcome.response, capabilityEnvelopeOutcome(outcome.envelope));
    }
    const normalized = normalizeMiddlewareShortCircuit(outcome.response);
    return audited(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return audited(capabilityInternalErrorResponse(options, error), "internal_error");
  }
}

function capabilityInternalErrorResponse<TContext>(
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

function audited(response: Response, outcome: string): { response: Response; outcome: string } {
  return { response, outcome };
}

/** Referer of a document form post, only when it stays on this origin. */
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
