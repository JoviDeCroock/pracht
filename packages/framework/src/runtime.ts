import { dispatchAgentProjection } from "./runtime-agent-projection.ts";
import { AGENT_SURFACE_ENABLED, initializeAgentSurface } from "./runtime-agent-surface.ts";
import { dispatchApiRequest } from "./runtime-api.ts";
import { shouldExposeServerErrors } from "./runtime-errors.ts";
import { dispatchPageRequest } from "./runtime-page-dispatch.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import { executePageMatch } from "./runtime-page-pipeline.ts";
import { isSameOriginRequest } from "./runtime-request-provenance.ts";
import { createRuntimeRequestState, resolveRuntimeApp } from "./runtime-request-setup.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  CapabilityAuditHook,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
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
  const { isRouteStateRequest, requestPath, url } = createRuntimeRequestState(options.request);
  const registry = options.registry ?? {};
  const resolvedApp = resolveRuntimeApp(options.app);
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

  return dispatchPageRequest({
    executePage,
    exposeDiagnostics,
    isRouteStateRequest,
    request: options.request,
    resolvedApp,
    url,
  });
}

// Public runtime surface — re-exported so `./runtime.ts` remains the
// single import entry for the framework's runtime API.
export { preventHeuristicCaching } from "./runtime-response-cache.ts";
export {
  applyDefaultSecurityHeaders,
  isProtocolSwitchResponse,
} from "./runtime-response-security.ts";
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
