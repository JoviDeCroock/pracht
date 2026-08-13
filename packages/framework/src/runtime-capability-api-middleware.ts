import {
  capabilityInternalErrorResponse,
  dispatchCapabilityHttp,
} from "./runtime-capability-http-dispatch.ts";
import {
  capabilityMiddlewareRoute,
  CAPABILITY_TIMEOUT_MS,
  normalizeMiddlewareShortCircuit,
} from "./runtime-capability-pipeline.ts";
import type {
  CapabilityDispatchResult,
  HandleCapabilityRequestOptions,
} from "./runtime-capability-transport-types.ts";
import { runMiddlewareChain } from "./runtime-middleware-chain.ts";

/** Wrap HTTP capability dispatch in the app-level API middleware chain. */
export async function dispatchCapabilityHttpWithApiMiddleware<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<CapabilityDispatchResult> {
  const middlewareFiles = options.apiMiddlewareFiles ?? [];
  if (middlewareFiles.length === 0) return dispatchCapabilityHttp(options);

  const holder: { dispatched: CapabilityDispatchResult | null } = { dispatched: null };
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
    if (dispatched && response === dispatched.response) return dispatched;

    const normalized = normalizeMiddlewareShortCircuit(response);
    return { response: normalized, outcome: `middleware_${normalized.status}` };
  } catch (error: unknown) {
    return {
      response: capabilityInternalErrorResponse(options, error),
      outcome: "internal_error",
    };
  }
}
