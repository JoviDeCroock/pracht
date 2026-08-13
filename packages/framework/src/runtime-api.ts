/**
 * Explicit API-route matching and execution.
 *
 * The server dispatcher gives API routes precedence over capability and page
 * projections, while this module owns the complete matched-route lifecycle:
 * exact-origin policy, middleware, method selection, handler invocation, and
 * error normalization.
 */

import { matchApiRoute } from "./app.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import type { PrachtRuntimeDiagnosticPhase } from "./runtime-errors.ts";
import { withEnhancedCapabilityFormRedirect } from "./runtime-capability-form-redirect.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { runMiddlewareChain } from "./runtime-middleware-chain.ts";
import { isSameOriginRequest } from "./runtime-request-provenance.ts";
import { renderApiErrorResponse } from "./runtime-api-error-response.ts";
import type {
  ApiRouteArgs,
  ApiRouteModule,
  HttpMethod,
  ModuleRegistry,
  ResolvedApiRoute,
} from "./types.ts";

export interface DispatchApiRequestOptions<TContext> {
  apiRoutes: ResolvedApiRoute[];
  context: TContext;
  debugErrors?: boolean;
  middlewareFiles: string[];
  registry: ModuleRegistry;
  request: Request;
  requireSameOrigin: boolean;
  url: URL;
}

/** Return the explicit API response, or `null` when no API route matched. */
export async function dispatchApiRequest<TContext>(
  options: DispatchApiRequestOptions<TContext>,
): Promise<Response | null> {
  const match = matchApiRoute(options.apiRoutes, options.url.pathname);
  if (!match) return null;

  let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";
  if (
    options.requireSameOrigin &&
    !SAFE_METHODS.has(options.request.method) &&
    !isSameOriginRequest(options.request, options.url)
  ) {
    return withDefaultSecurityHeaders(
      new Response("Cross-origin request blocked", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  const signal = AbortSignal.timeout(30_000);
  const terminal = async (): Promise<Response> => {
    currentPhase = "api";
    const apiModule = await resolveRegistryModule<ApiRouteModule>(
      options.registry.apiModules,
      match.route.file,
    );
    if (!apiModule) {
      throw new Error("API route module not found");
    }

    const method = options.request.method.toUpperCase() as HttpMethod;
    const handler = apiModule[method] ?? apiModule.default;
    if (!handler) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const args: ApiRouteArgs<TContext> = {
      request: options.request,
      params: match.params,
      context: options.context,
      signal,
      url: options.url,
      route: match.route,
    };
    return handler(args);
  };

  try {
    const response = await runMiddlewareChain({
      context: options.context,
      middlewareFiles: options.middlewareFiles,
      params: match.params,
      registry: options.registry,
      request: options.request,
      route: match.route,
      signal,
      url: options.url,
      terminal,
    });
    return normalizeApiResponse(response, options.request);
  } catch (error: unknown) {
    // A thrown Response is the handler answering, not failing. Guard response
    // normalization so a second throw becomes a 500 instead of escaping the
    // adapter as a rejected promise.
    let thrownResponseFailure: unknown;
    if (error instanceof Response) {
      try {
        return normalizeApiResponse(error, options.request);
      } catch (normalizeError: unknown) {
        thrownResponseFailure = normalizeError;
      }
    }

    return renderApiErrorResponse({
      error: thrownResponseFailure ?? error,
      middlewareFiles: options.middlewareFiles,
      options,
      phase: currentPhase,
      route: match.route,
    });
  }
}

function normalizeApiResponse(response: Response, request: Request): Response {
  return withDefaultSecurityHeaders(withEnhancedCapabilityFormRedirect(response, request));
}
