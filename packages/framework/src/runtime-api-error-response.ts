import {
  buildRuntimeDiagnostics,
  normalizeRouteError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import type { RuntimeResponseOptions } from "./runtime-response-types.ts";
import { jsonErrorResponse } from "./runtime-route-state-response.ts";
import type { ResolvedApiRoute } from "./types.ts";

export function renderApiErrorResponse<TContext>(options: {
  error: unknown;
  middlewareFiles: string[];
  options: RuntimeResponseOptions & { context?: TContext };
  phase: PrachtRuntimeDiagnosticPhase;
  route: ResolvedApiRoute;
}): Response {
  const exposeDetails = shouldExposeServerErrors(options.options);
  const routeError = normalizeRouteError(options.error, {
    exposeDetails,
  });
  const routeErrorWithDiagnostics = exposeDetails
    ? {
        ...routeError,
        diagnostics: buildRuntimeDiagnostics({
          middlewareFiles: options.middlewareFiles,
          phase: options.phase,
          route: options.route,
          status: routeError.status,
        }),
      }
    : routeError;

  if (exposeDetails) {
    return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: false });
  }

  const message =
    routeErrorWithDiagnostics.status >= 500
      ? "Internal Server Error"
      : routeErrorWithDiagnostics.message;
  return withDefaultSecurityHeaders(
    new Response(message, {
      status: routeErrorWithDiagnostics.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}
