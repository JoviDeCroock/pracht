/**
 * Shared capability validation, middleware, and execution pipeline.
 *
 * HTTP transport and direct server invocation both call this module so input
 * validation, named middleware, execution, output validation, and middleware
 * response normalization cannot diverge.
 */

import { canonicalJson } from "./runtime-confirmation.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import type { ResolvedCapability } from "./runtime-capability-registry.ts";
import type {
  CapabilityEnvelope,
  CapabilityErrorCode,
  CapabilityErrorPayload,
  ModuleRegistry,
  ResolvedApiRoute,
} from "./types.ts";

/** Longest a capability may run before its signal aborts, matching API routes. */
export const CAPABILITY_TIMEOUT_MS = 30_000;

export interface CapabilityPipelineOptions<TContext> {
  resolved: ResolvedCapability;
  input: unknown;
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  signal: AbortSignal;
  url: URL;
  /** Include internal error details (dev / direct server use). HTTP redacts in production. */
  exposeErrors: boolean;
  /**
   * Runs inside the middleware chain — after every named middleware, just
   * before the capability body — so gating (e.g. the destructive prepare/commit
   * confirmation flow) is subject to rate-limiting middleware. Returning an
   * envelope short-circuits `run()`; `null`/absent proceeds.
   */
  beforeRun?: (validatedInput: unknown) => Promise<{
    status: number;
    envelope: CapabilityEnvelope;
  } | null>;
}

export type CapabilityPipelineOutcome =
  | { kind: "envelope"; status: number; envelope: CapabilityEnvelope; response: Response }
  | { kind: "short-circuit"; response: Response };

/**
 * Run one capability through validation, middleware, and execution. The
 * middleware chain wraps the terminal exactly like page/API middleware does
 * (same `runMiddlewareChain`), so `next()`, context mutation, and
 * short-circuit semantics are identical everywhere.
 */
export async function runCapabilityPipeline<TContext>(
  options: CapabilityPipelineOptions<TContext>,
): Promise<CapabilityPipelineOutcome> {
  const { capability, name, middlewareFiles } = options.resolved;

  const validatedInput = capability.validateInput(options.input);
  if (!validatedInput.ok) {
    const envelope = errorEnvelope({
      code: "invalid_input",
      message: `Invalid input for capability "${name}".`,
      issues: validatedInput.issues,
    });
    return { kind: "envelope", status: 400, envelope, response: envelopeResponse(400, envelope) };
  }

  // Synthetic route descriptor handed to middleware, mirroring API dispatch.
  const syntheticRoute = capabilityMiddlewareRoute(options.resolved);

  // Holder object rather than a plain `let`: the value is assigned inside
  // the terminal closure, which TypeScript's control-flow analysis cannot see.
  const holder: { settled: { status: number; envelope: CapabilityEnvelope } | null } = {
    settled: null,
  };
  let terminalResponse: Response | null = null;

  const terminal = async (): Promise<Response> => {
    if (options.beforeRun) {
      const gate = await options.beforeRun(validatedInput.value);
      if (gate) {
        holder.settled = { status: gate.status, envelope: gate.envelope };
        terminalResponse = envelopeResponse(gate.status, gate.envelope);
        return terminalResponse;
      }
    }
    let output: unknown;
    try {
      output = await capability.run({
        input: validatedInput.value,
        context: options.context,
        request: options.request,
        signal: options.signal,
      });
    } catch (error: unknown) {
      holder.settled = {
        status: 500,
        envelope: errorEnvelope({
          code: "internal_error",
          message: options.exposeErrors
            ? `Capability "${name}" failed: ${error instanceof Error ? error.message : String(error)}`
            : "Capability failed.",
        }),
      };
      terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
      return terminalResponse;
    }

    const validatedOutput = capability.validateOutput(output);
    if (!validatedOutput.ok) {
      // Invalid output is a server bug — never return the raw value.
      holder.settled = {
        status: 500,
        envelope: errorEnvelope({
          code: "invalid_output",
          message: options.exposeErrors
            ? `Capability "${name}" produced output that does not match its output schema.`
            : "Capability failed.",
          issues: options.exposeErrors ? validatedOutput.issues : undefined,
        }),
      };
      terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
      return terminalResponse;
    }

    holder.settled = { status: 200, envelope: { ok: true, data: validatedOutput.value } };
    terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
    return terminalResponse;
  };

  const response = await runMiddlewareChain({
    context: options.context,
    middlewareFiles,
    params: {},
    registry: options.registry,
    request: options.request,
    route: syntheticRoute,
    signal: options.signal,
    url: options.url,
    terminal,
  });

  if (
    holder.settled &&
    (response === terminalResponse || (await responseMatchesEnvelope(response, holder.settled)))
  ) {
    return { kind: "envelope", ...holder.settled, response };
  }
  return { kind: "short-circuit", response };
}

async function responseMatchesEnvelope(
  response: Response,
  settled: { status: number; envelope: CapabilityEnvelope },
): Promise<boolean> {
  if (response.status !== settled.status) return false;
  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  try {
    return canonicalJson(await response.clone().json()) === canonicalJson(settled.envelope);
  } catch {
    return false;
  }
}

export function capabilityMiddlewareRoute(resolved: ResolvedCapability): ResolvedApiRoute {
  return {
    path: resolved.httpPath ?? `capability:${resolved.name}`,
    file: resolved.file,
    segments: [],
  };
}

/**
 * Middleware that returns without calling `next()` decides the response.
 * Redirects and 2xx responses pass through untouched; error statuses are
 * normalized into the envelope (status and headers preserved) so HTTP
 * callers always receive the typed shape.
 */
export function normalizeMiddlewareShortCircuit(response: Response): Response {
  if (response.status < 400) {
    return response;
  }

  const code = middlewareErrorCode(response.status);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(
    JSON.stringify(
      errorEnvelope({
        code,
        message: `Request rejected by middleware (status ${response.status}).`,
      }),
    ),
    { status: response.status, headers },
  );
}

export function middlewareErrorCode(status: number): CapabilityErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 300 && status < 400) return "redirect";
  return "middleware_rejected";
}

export function errorEnvelope(error: CapabilityErrorPayload): CapabilityEnvelope<never> {
  return { ok: false, error };
}

export function envelopeResponse(status: number, envelope: CapabilityEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
