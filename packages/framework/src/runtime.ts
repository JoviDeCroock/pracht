import { matchAppRoute, resolveApp } from "./app.ts";
import { dispatchAgentProjection } from "./runtime-agent-projection.ts";
import { AGENT_SURFACE_ENABLED, initializeAgentSurface } from "./runtime-agent-surface.ts";
import { dispatchApiRequest } from "./runtime-api.ts";
import { ROUTE_STATE_REQUEST_HEADER, SAFE_METHODS } from "./runtime-constants.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  shouldExposeServerErrors,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders, withRouteResponseHeaders } from "./runtime-headers.ts";
import { createNotFoundMatch, executePageMatch } from "./runtime-page-pipeline.ts";
import { isFirstPartyFetch, isSameOriginRequest } from "./runtime-request-provenance.ts";
import { jsonErrorResponse } from "./runtime-response.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  CapabilityAuditHook,
  ModuleRegistry,
  HrefRouteDefinition,
  PrachtApp,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  RouteMatch,
} from "./types.ts";

export interface HandlePrachtRequestOptions<TContext = unknown> {
  app: PrachtApp;
  request: Request;
  context?: TContext;
  registry?: ModuleRegistry;
  /** Expose raw server error details in rendered HTML and route-state JSON. */
  debugErrors?: boolean;
  clientEntryUrl?: string;
  /**
   * URL of the islands bootstrap script injected on `hydration: "islands"`
   * routes. Defaults to the URL registered by the generated server module
   * via `setIslandsClientEntryUrl()`.
   */
  islandsEntryUrl?: string;
  /**
   * Emit the islands bootstrap on islands-mode responses even when the render
   * captured no island components. Generated entries enable this when the
   * bootstrap owns another page-level runtime projection such as WebMCP.
   */
  islandsBootstrapRequired?: boolean;
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
  /** Per-source-file JS chunk map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  apiRoutes?: ResolvedApiRoute[];
  /**
   * Dev-only phase-timing collector. When provided, the runtime records
   * middleware/loader/render durations (ms) onto it so callers can emit a
   * `Server-Timing` header. Leave unset in production — no timing work runs.
   */
  timings?: PrachtPhaseTimings;
  /**
   * Structured audit callback invoked for every capability dispatch
   * (principal/agent, capability, effect, outcome, duration). Custom server
   * entries can pass it here; application code can alternatively register a
   * hook via `setCapabilityAuditHook()` from any server-only module.
   */
  onCapabilityAudit?: CapabilityAuditHook;
}

export async function handlePrachtRequest<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  const url = new URL(options.request.url);
  const hasDataParam = url.searchParams.get("_data") === "1";
  if (hasDataParam) {
    url.searchParams.delete("_data");
  }
  const requestPath = getRequestPath(url);
  const registry = options.registry ?? {};
  const resolvedApp = getResolvedApp(options.app);
  // The route-state endpoint returns loader output as JSON. Two entry
  // points into it: the explicit header (only settable via fetch, so the
  // browser forces CORS preflight cross-origin) and the `_data=1` query
  // param (settable by any <a href>, <link>, or redirect). To keep the
  // query-param form from becoming a CSRF oracle for GET loaders with
  // side effects, require browser provenance hints to indicate an exact
  // same-origin fetch/navigation. The header form does not need this
  // check — it's CORS-protected.
  const headerSignalsRouteState = options.request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1";
  const dataParamIsFirstParty = hasDataParam && isFirstPartyFetch(options.request);
  const isRouteStateRequest = headerSignalsRouteState || dataParamIsFirstParty;
  const exposeDiagnostics = shouldExposeServerErrors(options);
  const requireSameOrigin = options.app.api.requireSameOrigin ?? true;
  const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
    const middlewareFile = options.app.middleware[name];
    return middlewareFile ? [middlewareFile] : [];
  });
  // A WebSocket handshake is a GET, so the method check used for API
  // mutations would wave it through — but browsers do not apply CORS to
  // WebSocket. Apply the origin check before route dispatch because page
  // middleware and loaders can also short-circuit with a Response; protocol
  // switches from those paths must not create a bypass around the API guard.
  const isUpgradeRequest = options.request.headers.has("upgrade");
  if (requireSameOrigin && isUpgradeRequest && !isSameOriginRequest(options.request, url)) {
    return withDefaultSecurityHeaders(
      new Response("Cross-origin WebSocket upgrade blocked", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  const agentSurface = await initializeAgentSurface({
    app: options.app,
    context: options.context,
    exposeDiagnostics,
    onAudit: options.onCapabilityAudit,
    registry,
    request: options.request,
  });
  if (!agentSurface.ok) return agentSurface.response;
  const { agent, capabilityRuntime, context: requestContext, hasCapabilities } = agentSurface;
  const { mcpConfig, mcpRuntime } = agentSurface;

  if (options.apiRoutes?.length) {
    const apiResponse = await dispatchApiRequest({
      apiRoutes: options.apiRoutes,
      context: requestContext,
      debugErrors: options.debugErrors,
      middlewareFiles: apiMiddlewareFiles,
      registry,
      request: options.request,
      requireSameOrigin,
      url,
    });
    if (apiResponse) return apiResponse;
  }

  // Keep the build-time guard explicit at the projection site. Returning the
  // lazy runtime through the initialization boundary hides its proven `null`
  // value from some bundlers; this constant lets them remove the whole branch.
  if (AGENT_SURFACE_ENABLED && capabilityRuntime) {
    const projectionResponse = await dispatchAgentProjection({
      agent,
      apiMiddlewareFiles,
      app: options.app,
      capabilityRuntime,
      context: requestContext,
      exposeErrors: exposeDiagnostics,
      hasCapabilities,
      mcpConfig,
      mcpRuntime,
      onAudit: options.onCapabilityAudit,
      registry,
      request: options.request,
      requireSameOrigin,
      url,
    });
    if (projectionResponse) return projectionResponse;
  }

  const executePage = (
    pageMatch: RouteMatch,
    pageOptions: { isNotFoundPage: boolean; status: number },
  ): Promise<Response> =>
    executePageMatch({
      clientEntryUrl: options.clientEntryUrl,
      context: requestContext,
      cssManifest: options.cssManifest,
      debugErrors: options.debugErrors,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      islandsEntryUrl: options.islandsEntryUrl,
      isNotFoundPage: pageOptions.isNotFoundPage,
      isRouteStateRequest,
      jsManifest: options.jsManifest,
      match: pageMatch,
      registry,
      request: options.request,
      requestPath,
      resolvedApp,
      status: pageOptions.status,
      timings: options.timings,
      url,
    });

  const match = matchAppRoute(resolvedApp, url.pathname);

  if (!match) {
    if (isRouteStateRequest) {
      return jsonErrorResponse(
        createSerializedRouteError("Not found", 404, {
          diagnostics: exposeDiagnostics
            ? buildRuntimeDiagnostics({
                phase: "match",
                status: 404,
              })
            : undefined,
          name: "Error",
        }),
        { isRouteStateRequest: true },
      );
    }

    // Nothing matched. When the app declares a `notFound` page, render it
    // with a 404 status — it lives outside the route table, so unlike a
    // catch-all route it only ever runs *after* matching (and, in every
    // first-party adapter, after static-asset serving) has failed.
    const notFoundMatch = createNotFoundMatch(resolvedApp, url.pathname);
    if (notFoundMatch && SAFE_METHODS.has(options.request.method)) {
      return executePage(notFoundMatch, { isNotFoundPage: true, status: 404 });
    }

    return withDefaultSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (!SAFE_METHODS.has(options.request.method)) {
    if (isRouteStateRequest) {
      return jsonErrorResponse(
        createSerializedRouteError("Method not allowed", 405, {
          diagnostics: exposeDiagnostics
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
      { isRouteStateRequest },
    );
  }

  return executePage(match, { isNotFoundPage: false, status: 200 });
}

function getRequestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function getResolvedApp(app: PrachtApp): ResolvedPrachtApp {
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

// Public runtime surface — re-exported so `./runtime.ts` remains the
// single import entry for the framework's runtime API.
export {
  applyDefaultSecurityHeaders,
  isProtocolSwitchResponse,
  preventHeuristicCaching,
} from "./runtime-headers.ts";
export { isFirstPartyFetch } from "./runtime-request-provenance.ts";
export { formatServerTimingHeader, type PrachtPhaseTimings } from "./runtime-timing.ts";
export {
  deserializeRouteError,
  type PrachtRuntimeDiagnosticPhase,
  type PrachtRuntimeDiagnostics,
  type SerializedRouteError,
} from "./runtime-errors.ts";
export {
  Form,
  Link,
  PrachtRuntimeProvider,
  readHydrationState,
  startApp,
  useLocation,
  useNavigation,
  useParams,
  useRevalidate,
  useRouteData,
  useSearchParams,
  type FormProps,
  type LinkProps,
  type Location,
  type Navigation,
  type NavigationLocation,
  type PrachtHydrationState,
  type ReadonlyURLSearchParams,
  type StartAppOptions,
} from "./runtime-hooks.ts";
export {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  type RouteStateResult,
} from "./runtime-client-fetch.ts";
