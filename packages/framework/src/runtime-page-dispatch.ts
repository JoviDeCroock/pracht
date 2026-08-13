import { matchAppRoute } from "./app-matching.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import { buildRuntimeDiagnostics, createSerializedRouteError } from "./runtime-errors.ts";
import { createNotFoundMatch } from "./runtime-page-pipeline.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import { withRouteResponseHeaders } from "./runtime-route-response-headers.ts";
import { jsonErrorResponse } from "./runtime-route-state-response.ts";
import type { ResolvedPrachtApp, RouteMatch } from "./types.ts";

export interface DispatchPageRequestOptions {
  request: Request;
  url: URL;
  resolvedApp: ResolvedPrachtApp;
  isRouteStateRequest: boolean;
  exposeDiagnostics: boolean;
  executePage: (
    match: RouteMatch,
    options: { isNotFoundPage: boolean; status: number },
  ) => Promise<Response>;
}

/** Match and settle the terminal page projection after API and agent routing. */
export async function dispatchPageRequest(options: DispatchPageRequestOptions): Promise<Response> {
  const match = matchAppRoute(options.resolvedApp, options.url.pathname);

  if (!match) {
    if (options.isRouteStateRequest) {
      return jsonErrorResponse(
        createSerializedRouteError("Not found", 404, {
          diagnostics: options.exposeDiagnostics
            ? buildRuntimeDiagnostics({ phase: "match", status: 404 })
            : undefined,
          name: "Error",
        }),
        { isRouteStateRequest: true },
      );
    }

    const notFoundMatch = createNotFoundMatch(options.resolvedApp, options.url.pathname);
    if (notFoundMatch && SAFE_METHODS.has(options.request.method)) {
      return options.executePage(notFoundMatch, { isNotFoundPage: true, status: 404 });
    }

    return withDefaultSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (!SAFE_METHODS.has(options.request.method)) {
    if (options.isRouteStateRequest) {
      return jsonErrorResponse(
        createSerializedRouteError("Method not allowed", 405, {
          diagnostics: options.exposeDiagnostics
            ? buildRuntimeDiagnostics({
                middlewareFiles: match.route.middlewareFiles,
                phase: "action",
                route: match.route,
                shellFile: match.route.shellFile,
                status: 405,
              })
            : undefined,
          name: "Error",
        }),
        { isRouteStateRequest: true },
      );
    }

    return withRouteResponseHeaders(
      new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      { isRouteStateRequest: options.isRouteStateRequest },
    );
  }

  return options.executePage(match, { isNotFoundPage: false, status: 200 });
}
