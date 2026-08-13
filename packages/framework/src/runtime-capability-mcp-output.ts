import { errorEnvelope } from "./runtime-capability-pipeline.ts";
import type {
  CapabilityDispatchResult,
  HandleCapabilityRequestOptions,
} from "./runtime-capability-transport-types.ts";

/**
 * MCP advertises the capability's output schema in `tools/list`. Middleware
 * can short-circuit with its own success envelope before the capability
 * pipeline validates output, so validate that envelope before the audit event
 * and status are finalized. The MCP adapter can then translate the same
 * settled response without making its audit trail disagree with the client.
 */
export async function revalidateMcpSuccessEnvelope<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  dispatched: CapabilityDispatchResult,
): Promise<CapabilityDispatchResult> {
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

  return {
    response: new Response(
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
    outcome: "invalid_output",
  };
}
