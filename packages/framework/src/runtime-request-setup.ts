import { resolveApp } from "./app-resolution.ts";
import { ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import { isFirstPartyFetch } from "./runtime-request-provenance.ts";
import type { HrefRouteDefinition, PrachtApp, ResolvedPrachtApp } from "./types.ts";

export interface RuntimeRequestState {
  url: URL;
  requestPath: string;
  isRouteStateRequest: boolean;
}

/** Normalize request URL state and classify trusted route-state requests. */
export function createRuntimeRequestState(request: Request): RuntimeRequestState {
  const url = new URL(request.url);
  const hasDataParam = url.searchParams.get("_data") === "1";
  if (hasDataParam) url.searchParams.delete("_data");

  // The header form is CORS-preflight protected. The linkable `_data=1`
  // fallback additionally requires browser provenance to prevent GET-loader
  // CSRF oracles.
  const headerSignalsRouteState = request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1";
  const dataParamIsFirstParty = hasDataParam && isFirstPartyFetch(request);

  return {
    url,
    requestPath: `${url.pathname}${url.search}`,
    isRouteStateRequest: headerSignalsRouteState || dataParamIsFirstParty,
  };
}

/** Preserve generated resolved manifests; resolve source-form apps on demand. */
export function resolveRuntimeApp(app: PrachtApp): ResolvedPrachtApp {
  const routes = (app as { routes: readonly unknown[] }).routes;
  const notFoundResolved = !app.notFound || "segments" in app.notFound;
  if ((routes.length === 0 || isHrefRouteDefinition(routes[0])) && notFoundResolved) {
    return app as unknown as ResolvedPrachtApp;
  }
  return resolveApp(app);
}

function isHrefRouteDefinition(value: unknown): value is HrefRouteDefinition {
  return Boolean(
    value &&
    typeof value === "object" &&
    "path" in value &&
    "segments" in value &&
    Array.isArray((value as { segments?: unknown }).segments),
  );
}
