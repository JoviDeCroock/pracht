/**
 * The front half of the server request pipeline.
 *
 * `handlePrachtRequest` in `runtime.ts` is the orchestrator; this module owns
 * the units it calls before a page is ever matched:
 *
 *   • `createRequestContext` — base-path restoration, the canonical URL, the
 *     registry/app lookups, and the request-scoped agent surface.
 *   • `dispatchApi` — API route matching, the CSRF gate, and the middleware
 *     chain around the handler.
 *   • `dispatchAgentSurface` — remote MCP and the capability HTTP projections.
 *
 * Each takes the same explicit `PrachtRequestContext` instead of closing over
 * the handler's locals, so each is callable — and testable — on its own.
 *
 * Every `await import()` boundary and every `__PRACHT_AGENT_SURFACE__` gate is
 * exactly where it was: an app that registers no capabilities and configures no
 * agents must not pay for either, at bundle time or on the hot path.
 *
 * @internal Not part of the published API. `runtime.ts` re-exports the few
 * names adapters use.
 */
import { DEFAULT_LOADER_TIMEOUT_MS, matchApiRoute, resolveApp } from "./app.ts";
import { resolveBaseRedirectLocation, restoreBasePathInRequest, stripBase } from "./base.ts";
import {
  OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
  ROUTE_STATE_REQUEST_HEADER,
  SAFE_METHODS,
} from "./runtime-constants.ts";
import {
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
  type RouteErrorContext,
} from "./runtime-errors.ts";
import {
  withDefaultSecurityHeaders,
  withEnhancedCapabilityFormRedirect,
} from "./runtime-headers.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import { renderApiErrorResponse } from "./runtime-response.ts";
import type { ResolvedCapability } from "./runtime-capabilities.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  ApiRouteArgs,
  ApiRouteModule,
  CapabilityAuditHook,
  HrefRouteDefinition,
  HttpMethod,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtApp,
  PrachtContextExtensions,
  ResolvedApiRoute,
  ResolvedPrachtApp,
} from "./types.ts";

const SAME_ORIGIN_FETCH_SITE = "same-origin";

/**
 * Build-time proof that the app has no agent surface at all — no registered
 * capabilities and no `defineApp({ agents })`. The vite plugin only defines it
 * as `false` when it can read the manifest and see both are absent; anything it
 * cannot prove (a pages-router app, an unreadable manifest, a spread config)
 * leaves it undefined and the runtime checks below decide as before.
 *
 * When it is `false` the capability and Web Bot Auth runtimes are unreachable,
 * so the bundler drops both from the server bundle: an app that does not use
 * the agent surface does not ship it. See docs/CAPABILITIES.md.
 */
declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

export interface HandlePrachtRequestOptions<TContext = unknown> {
  /**
   * Authoring-shaped or already-resolved app. Generated server entries pass
   * the resolved one, which is also the only shape that can carry
   * `hrefRoutes`.
   */
  app: PrachtApp | ResolvedPrachtApp;
  request: Request;
  /**
   * Set when a trusted upstream removed Vite's deploy base from the request
   * pathname before forwarding it. This is explicit because a base-free route
   * may itself begin with the same segments as the base, making prefix-based
   * inference ambiguous.
   */
  basePathStripped?: boolean;
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
  /**
   * Called with the raw error whenever a page render fails, before it is
   * normalized into a response. The response body deliberately hides server
   * error details outside `debugErrors`, which leaves a build-time caller
   * (prerendering, static export) with a bare status and no cause. Prerender
   * passes this so a failing SSG page can name what actually threw.
   */
  onRouteError?: (error: unknown, requestPath: string, context?: RouteErrorContext) => void;
}

/**
 * Everything the pipeline stages share about one request, resolved once.
 *
 * `options.request` and `request` are the same object by construction, so no
 * stage can accidentally read a different URL than its neighbour.
 */
export interface PrachtRequestContext<TContext = unknown> {
  options: HandlePrachtRequestOptions<TContext>;
  /**
   * The incoming request with the deploy base restored and the framework's
   * internal `_data=1` marker removed, so `request.url` and `url` always agree.
   */
  request: Request;
  /** Canonical request URL: deploy base intact, `_data` stripped. */
  url: URL;
  /**
   * `${url.pathname}${url.search}` — the URL the visitor is at. Drives
   * `useLocation()` and the serialized hydration state, which the client
   * compares against `window.location`.
   */
  requestPath: string;
  /**
   * Base-free request path. Everything the app declares — routes, API routes,
   * capability endpoints — is addressed without the deploy base, while the
   * request carries it.
   */
  routePathname: string;
  registry: ModuleRegistry;
  resolvedApp: ResolvedPrachtApp;
  /**
   * What `<Link route=…>` and `href()` resolve against. Normally the route
   * table itself; a static export's 404/fallback render empties `routes` so
   * no dynamic pattern can consume the synthetic request, and passes the real
   * table separately so the shell's links still build.
   */
  hrefRoutes: readonly HrefRouteDefinition[];
  loaderTimeoutMs: number;
  isRouteStateRequest: boolean;
  exposeDiagnostics: boolean;
  requireSameOrigin: boolean;
  /** Shared request context, after any agent-identity binding. */
  context: TContext & PrachtContextExtensions;
  hasCapabilities: boolean;
  mcpConfig: NonNullable<PrachtApp["agents"]>["mcp"] | undefined;
  capabilityRuntime: typeof import("./runtime-capabilities.ts") | null;
  mcpRuntime: typeof import("./runtime-mcp.ts") | null;
  agent: PrachtAgentIdentity | null;
  /** The request path is the configured remote MCP endpoint. */
  targetsMcpEndpoint: boolean;
  /** …and the MCP runtime is loaded, so the endpoint can actually answer. */
  isMcpRequest: boolean;
}

/**
 * `createRequestContext` either produced a context or already answered the
 * request (a base redirect, a path outside the base, a blocked upgrade, a
 * context that cannot carry verified agent identity).
 */
export type RequestContextResult<TContext> =
  | { response: Response; ctx?: undefined }
  | { response?: undefined; ctx: PrachtRequestContext<TContext> };

/** Validate the request budget where the server consumes it. */
function resolveLoaderTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOADER_TIMEOUT_MS;
  if (Number.isFinite(value) && value > 0) return value;
  throw new TypeError(
    `defineApp({ loaderTimeoutMs }) must be a positive number of milliseconds, received ${JSON.stringify(value)}.`,
  );
}

/**
 * The `AbortSignal` handed to middleware, loaders, and API route handlers.
 *
 * Two independent reasons to stop the work are folded into one signal: the
 * server-side budget (`defineApp({ loaderTimeoutMs })`, 30s by default) and
 * the client going away. Composing them is what makes `signal` worth passing
 * to `fetch()` or a database driver — a timeout alone keeps a request the
 * caller has already abandoned running to completion.
 *
 * `AbortSignal.any` is not available everywhere, so runtimes without it get
 * the same signal wired by hand. Dropping either half there would keep work
 * running after its client has gone away.
 */
export function composeRequestSignal(request: Request, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const clientSignal: AbortSignal | undefined = request.signal;
  if (!clientSignal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([clientSignal, timeout]);

  const controller = new AbortController();
  if (clientSignal.aborted) {
    controller.abort(clientSignal.reason);
    return controller.signal;
  }
  if (timeout.aborted) {
    controller.abort(timeout.reason);
    return controller.signal;
  }

  const onClientAbort = () => {
    timeout.removeEventListener("abort", onTimeoutAbort);
    controller.abort(clientSignal.reason);
  };
  const onTimeoutAbort = () => {
    clientSignal.removeEventListener("abort", onClientAbort);
    controller.abort(timeout.reason);
  };
  clientSignal.addEventListener("abort", onClientAbort, { once: true });
  timeout.addEventListener("abort", onTimeoutAbort, { once: true });
  return controller.signal;
}

/** Distinguish a client disconnect from a request-budget expiry. */
export function isClientDisconnect(request: Request, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if ((signal.reason as { name?: string } | undefined)?.name === "TimeoutError") return false;
  return request.signal?.aborted === true;
}

/**
 * Stricter variant of first-party detection used to protect API requests
 * that a cross-site page must not be able to make on the user's behalf:
 * state-changing methods (CSRF) and WebSocket upgrades (cross-site
 * WebSocket hijacking). It rejects any browser signal that points outside
 * this exact origin — a cross-origin form POST will send `Origin` from the
 * attacker, and `Sec-Fetch-Site: same-site` is not enough because sibling
 * subdomains can be attacker-controlled. Requests with no browser
 * provenance headers are treated as non-browser callers.
 */
export function isSameOriginRequest(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== SAME_ORIGIN_FETCH_SITE) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }

  if (site === SAME_ORIGIN_FETCH_SITE) {
    return true;
  }

  // No Sec-Fetch-Site AND no Origin: fall back to Referer. Browsers
  // always send Origin on POST to same-origin endpoints, so a POST
  // missing both is almost certainly a non-browser caller.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }

  // No browser-provided signals at all — allow (curl, server-to-server,
  // tests). The threat model here is CSRF via browser forms, which
  // cannot produce a request with none of these headers set.
  return true;
}

/**
 * Heuristic "this request came from our own page" check. Used to gate
 * the `_data=1` query-param form of the route-state endpoint, which is
 * otherwise reachable via any cross-origin `<a href>` / redirect.
 *
 * Accepts a request as first-party when:
 *   - Sec-Fetch-Site is `same-origin` (modern browsers),
 *   - OR Sec-Fetch-Site is absent AND the Origin header matches the
 *     request URL's origin (older clients that still send Origin),
 *   - OR Sec-Fetch-Site/Origin are absent AND Referer matches the request
 *     URL's origin,
 *   - OR no Origin/Sec-Fetch-Site/Referer is present (non-browser clients like
 *     curl — CSRF is not the threat model there; blocking would break
 *     tests and CLIs).
 */
export function isFirstPartyFetch(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== SAME_ORIGIN_FETCH_SITE) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  if (site === SAME_ORIGIN_FETCH_SITE) {
    return true;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Canonicalize a document request for a bare deploy base before an adapter's
 * static-file fast path can serve it as the root route.
 *
 * @internal
 */
export function createBaseRedirectResponse(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const location = resolveBaseRedirectLocation(url.pathname, url.search);
  if (!location) return null;

  return withDefaultSecurityHeaders(
    new Response(null, {
      status: 308,
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        location,
      },
    }),
  );
}

/** Files backing `api.middleware`, in declaration order, skipping unknown names. */
function resolveApiMiddlewareFiles(app: PrachtApp | ResolvedPrachtApp): string[] {
  return (app.api.middleware ?? []).flatMap((name) => {
    const middlewareFile = app.middleware[name];
    return middlewareFile ? [middlewareFile] : [];
  });
}

function plainTextResponse(body: string, status: number): Response {
  return withDefaultSecurityHeaders(
    new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } }),
  );
}

/**
 * OAuth 2.0 protected-resource metadata (RFC 9728), served only when the app
 * opted into `agents.mcp.auth`.
 *
 * Deliberately ahead of `stripBase()`: §3.1 inserts the well-known segment
 * between the host and the resource's path, so the document lives at the
 * ORIGIN ROOT and is outside any deploy base by construction. Matching a
 * base-stripped route path would answer `null` and 404 the very URL the
 * `WWW-Authenticate` challenge tells hosts to fetch. The literal prefix test
 * keeps this to one string comparison for every other request, and no
 * MCP module is loaded unless the path really is the well-known one.
 */
async function dispatchOAuthResourceMetadata<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
  url: URL,
): Promise<Response | undefined> {
  const metadataAuth = options.app.agents?.mcp?.auth;
  if (!metadataAuth || !url.pathname.includes(OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)) {
    return undefined;
  }

  // This branch returns before normal route resolution. Resolve the app
  // explicitly so malformed security config cannot publish metadata that every
  // other request rejects.
  const resolvedMetadataAuth = getResolvedApp(options.app as PrachtApp).agents?.mcp?.auth;
  if (!resolvedMetadataAuth) {
    throw new Error("Resolved MCP OAuth configuration is missing.");
  }
  const mcpAuthRuntime = await import("./runtime-mcp.ts");
  if (!mcpAuthRuntime.isMcpResourceMetadataPath(url.pathname, resolvedMetadataAuth)) {
    return undefined;
  }
  return withDefaultSecurityHeaders(
    await mcpAuthRuntime.handleMcpMetadataRequest(options.request, resolvedMetadataAuth),
  );
}

interface AgentSurfacePreparation<TContext> {
  response?: Response;
  capabilityRuntime: typeof import("./runtime-capabilities.ts") | null;
  mcpRuntime: typeof import("./runtime-mcp.ts") | null;
  agent: PrachtAgentIdentity | null;
  context: TContext & PrachtContextExtensions;
}

/**
 * Load the request-scoped agent surface: the capability and MCP runtimes, the
 * Web Bot Auth identity, and the capability host registration that makes
 * `invokeCapability()` work from loaders, middleware, and API routes.
 *
 * The agent surface loads on demand: apps that register no capabilities and
 * configure no agents never import either module, and builds that can prove it
 * statically drop them from the bundle outright.
 */
async function prepareAgentSurface<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
  registry: ModuleRegistry,
  initialContext: TContext & PrachtContextExtensions,
  hasCapabilities: boolean,
  mcpConfig: NonNullable<PrachtApp["agents"]>["mcp"] | undefined,
  exposeDiagnostics: boolean,
): Promise<AgentSurfacePreparation<TContext>> {
  let requestContext = initialContext;
  let capabilityRuntime: typeof import("./runtime-capabilities.ts") | null = null;
  let mcpRuntime: typeof import("./runtime-mcp.ts") | null = null;
  let agent: PrachtAgentIdentity | null = null;

  if (typeof __PRACHT_AGENT_SURFACE__ === "undefined" || __PRACHT_AGENT_SURFACE__) {
    if (hasCapabilities || mcpConfig) {
      [capabilityRuntime, mcpRuntime] = await Promise.all([
        import("./runtime-capabilities.ts"),
        mcpConfig ? import("./runtime-mcp.ts") : Promise.resolve(null),
      ]);
    }
    // Web Bot Auth: verify the agent signature once per request when the app
    // opted in via `defineApp({ agents: { webBotAuth } })`. The result (identity
    // or null) lands on the shared request context before middleware, loaders,
    // API routes, or capabilities run. Apps without the config skip everything —
    // a single property check.
    const webBotAuth = options.app.agents?.webBotAuth;
    if (webBotAuth) {
      const { bindAgentContext } = await import("./runtime-agent-context.ts");
      if (options.request.headers.has("signature-input")) {
        const { verifyAgentSignature } = await import("./runtime-agent-auth.ts");
        agent = await verifyAgentSignature(options.request, webBotAuth);
      }
      try {
        requestContext = bindAgentContext(requestContext, agent);
      } catch (error: unknown) {
        // A context the framework cannot bind identity to (a native built-in,
        // an application-owned `agent` field it must not replace, or a context
        // object reused across identities) fails closed. Deliver that as a 500
        // rather than rejecting: a rejection out of `handlePrachtRequest` is an
        // unhandled rejection in the adapter, not a response.
        warnAgentContextBindingFailure(error);
        return {
          response: plainTextResponse(
            exposeDiagnostics
              ? `Request context could not carry verified agent identity: ${
                  error instanceof Error ? error.message : String(error)
                }`
              : "Internal Server Error",
            500,
          ),
          capabilityRuntime,
          mcpRuntime,
          agent,
          context: requestContext,
        };
      }
      agent = requestContext.agent ?? null;
    }

    // Register the request so `invokeCapability()` works from loaders, API
    // routes, and middleware. An actual MCP dispatch replaces this provenance
    // after explicit API-route precedence has been resolved.
    if (capabilityRuntime && (hasCapabilities || mcpConfig)) {
      capabilityRuntime.setActiveCapabilityHost(
        options.request,
        options.app,
        registry,
        "http",
        options.onCapabilityAudit,
        agent,
      );
    }
  } else if (hasCapabilities || options.app.agents) {
    // The build proved there was no agent surface and dropped the runtime, yet
    // one is registered here. Only reachable if the manifest analyzer missed a
    // registration; say so loudly rather than 404ing capabilities in silence.
    warnAgentSurfaceElided();
  }

  return { capabilityRuntime, mcpRuntime, agent, context: requestContext };
}

/**
 * Normalize one request into the shared context every later stage reads, or
 * answer it outright when the URL never belongs to this app.
 */
export async function createRequestContext<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<RequestContextResult<TContext>> {
  if (options.basePathStripped) {
    options = {
      ...options,
      basePathStripped: false,
      request: restoreBasePathInRequest(options.request),
    };
  }
  const baseRedirect = createBaseRedirectResponse(options.request);
  if (baseRedirect) return { response: baseRedirect };
  const url = new URL(options.request.url);
  const hasDataParam = url.searchParams.get("_data") === "1";
  if (hasDataParam) {
    url.searchParams.delete("_data");
    // `_data=1` is the framework's own route-state marker, not part of the URL
    // the app was asked for. Strip it from the request as well as from `url`,
    // so a loader reading `new URL(args.request.url)` and one reading `args.url`
    // cannot disagree about the query string — which they did for as long as
    // only `url` was cleaned.
    options = { ...options, request: new Request(url, options.request) };
  }

  if (typeof __PRACHT_AGENT_SURFACE__ === "undefined" || __PRACHT_AGENT_SURFACE__) {
    const metadataResponse = await dispatchOAuthResourceMetadata(options, url);
    if (metadataResponse) return { response: metadataResponse };
  }

  const routePathname = stripBase(url.pathname);
  // Outside the configured base belongs to another app on the same origin.
  // A proxy-rewritten request must opt into the base-free interpretation
  // above; inferring it here would make a legitimate first route segment that
  // matches the base impossible to distinguish from a retained public base.
  if (routePathname === null) {
    return { response: plainTextResponse("Not found", 404) };
  }
  const requestPath = `${url.pathname}${url.search}`;
  const registry = options.registry ?? {};
  const resolvedApp = getResolvedApp(options.app as PrachtApp);
  const hrefRoutes = resolvedApp.hrefRoutes ?? resolvedApp.routes;
  const loaderTimeoutMs = resolveLoaderTimeoutMs(resolvedApp.loaderTimeoutMs);
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
  // A WebSocket handshake is a GET, so the method check used for API
  // mutations would wave it through — but browsers do not apply CORS to
  // WebSocket. Apply the origin check before route dispatch because page
  // middleware and loaders can also short-circuit with a Response; protocol
  // switches from those paths must not create a bypass around the API guard.
  const isUpgradeRequest = options.request.headers.has("upgrade");
  if (requireSameOrigin && isUpgradeRequest && !isSameOriginRequest(options.request, url)) {
    return { response: plainTextResponse("Cross-origin WebSocket upgrade blocked", 403) };
  }

  const hasCapabilities = Object.keys(options.app.capabilities ?? {}).length > 0;
  const mcpConfig = options.app.agents?.mcp;
  const surface = await prepareAgentSurface(
    options,
    registry,
    (options.context ?? {}) as TContext & PrachtContextExtensions,
    hasCapabilities,
    mcpConfig,
    exposeDiagnostics,
  );
  if (surface.response) return { response: surface.response };

  const configuredMcpEndpoint = mcpConfig?.path ?? "/mcp";
  const normalizedRoutePath =
    routePathname.length > 1 && routePathname.endsWith("/")
      ? routePathname.slice(0, -1)
      : routePathname;
  const normalizedMcpEndpoint =
    configuredMcpEndpoint.length > 1 && configuredMcpEndpoint.endsWith("/")
      ? configuredMcpEndpoint.slice(0, -1)
      : configuredMcpEndpoint;
  const targetsMcpEndpoint = !!mcpConfig && normalizedRoutePath === normalizedMcpEndpoint;

  return {
    ctx: {
      options,
      request: options.request,
      url,
      requestPath,
      routePathname,
      registry,
      resolvedApp,
      hrefRoutes,
      loaderTimeoutMs,
      isRouteStateRequest,
      exposeDiagnostics,
      requireSameOrigin,
      context: surface.context,
      hasCapabilities,
      mcpConfig,
      capabilityRuntime: surface.capabilityRuntime,
      mcpRuntime: surface.mcpRuntime,
      agent: surface.agent,
      targetsMcpEndpoint,
      isMcpRequest: targetsMcpEndpoint && !!surface.mcpRuntime,
    },
  };
}

/**
 * Match and run an API route: the CSRF gate, the `api.middleware` chain, and
 * the method handler. Returns `undefined` when no API route claims the path.
 */
export async function dispatchApi<TContext>(
  ctx: PrachtRequestContext<TContext>,
): Promise<Response | undefined> {
  const { options, registry, request, url } = ctx;
  if (!options.apiRoutes?.length) return undefined;
  const apiMatch = matchApiRoute(options.apiRoutes, ctx.routePathname);
  if (!apiMatch) return undefined;

  // An explicit API route normally wins over generated capability routes,
  // but it must never bypass an MCP endpoint's transport and OAuth gates.
  // Treat the duplicate pathname as an invalid deployment and fail closed.
  if (ctx.targetsMcpEndpoint) {
    return plainTextResponse(
      ctx.exposeDiagnostics
        ? `API route ${JSON.stringify(apiMatch.route.path)} collides with the configured remote MCP endpoint.`
        : "Internal Server Error",
      500,
    );
  }

  const apiMiddlewareFiles = resolveApiMiddlewareFiles(options.app);
  let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

  if (
    ctx.requireSameOrigin &&
    !SAFE_METHODS.has(request.method) &&
    !isSameOriginRequest(request, url)
  ) {
    return plainTextResponse("Cross-origin request blocked", 403);
  }

  const requestSignal = composeRequestSignal(request, ctx.loaderTimeoutMs);
  const apiContext = ctx.context;

  const apiTerminal = async (): Promise<Response> => {
    currentPhase = "api";
    const apiModule = await resolveRegistryModule<ApiRouteModule>(
      registry.apiModules,
      apiMatch.route.file,
    );

    if (!apiModule) {
      throw new Error("API route module not found");
    }

    const method = request.method.toUpperCase() as HttpMethod;
    const handler = apiModule[method] ?? apiModule.default;

    if (!handler) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const apiRouteArgs: ApiRouteArgs<TContext> = {
      request,
      params: apiMatch.params,
      pathname: apiMatch.pathname,
      context: apiContext,
      signal: requestSignal,
      url,
      route: apiMatch.route,
    };

    return handler(apiRouteArgs);
  };

  try {
    const response = await runMiddlewareChain({
      context: apiContext,
      middlewareFiles: apiMiddlewareFiles,
      params: apiMatch.params,
      pathname: apiMatch.pathname,
      registry,
      request,
      route: apiMatch.route,
      signal: requestSignal,
      url,
      terminal: apiTerminal,
    });
    return withDefaultSecurityHeaders(withEnhancedCapabilityFormRedirect(response, request));
  } catch (error: unknown) {
    // Same short-circuit contract as page loaders: a thrown `Response` is
    // the handler answering, not failing. Guarded because this runs inside
    // the catch, where a further throw would reject out of
    // `handlePrachtRequest` instead of becoming a 500.
    let thrownResponseFailure: unknown;
    if (error instanceof Response) {
      try {
        return withDefaultSecurityHeaders(withEnhancedCapabilityFormRedirect(error, request));
      } catch (normalizeError: unknown) {
        thrownResponseFailure = normalizeError;
      }
    }

    return renderApiErrorResponse({
      error: thrownResponseFailure ?? error,
      middlewareFiles: apiMiddlewareFiles,
      options,
      phase: currentPhase,
      route: apiMatch.route,
    });
  }
}

/**
 * Capability projections and the remote MCP endpoint. Explicit API route files
 * take precedence (`dispatchApi` runs first). A configured MCP endpoint remains
 * live with an empty or broken graph so clients receive an empty list or a
 * protocol error instead of falling through to the application's page router.
 *
 * Returns `undefined` when nothing on the agent surface claims the path.
 */
export async function dispatchAgentSurface<TContext>(
  ctx: PrachtRequestContext<TContext>,
): Promise<Response | undefined> {
  // The same gate `prepareAgentSurface` uses. Redundant at runtime — with the
  // surface proven absent `capabilityRuntime` is always null and the guard
  // below already returns — but stating it here is what lets the bundler prove
  // the capability and MCP dispatch is unreachable and drop it. Reading the
  // runtime off a context object is opaque to it; reading the define is not.
  if (typeof __PRACHT_AGENT_SURFACE__ !== "undefined" && !__PRACHT_AGENT_SURFACE__) {
    return undefined;
  }
  const { capabilityRuntime, hasCapabilities, isMcpRequest, options, registry, request, url } = ctx;
  if (!capabilityRuntime || !(hasCapabilities || isMcpRequest)) return undefined;

  if (isMcpRequest) {
    // Adapter contexts may retain the incoming transport request. Bind the
    // same trusted provenance as the synthesized capability request so that
    // using either request for composition preserves the MCP guard.
    capabilityRuntime.setActiveCapabilityHost(
      request,
      options.app,
      registry,
      "mcp",
      options.onCapabilityAudit,
      ctx.agent,
    );
  }
  const {
    CAPABILITY_HTTP_PREFIX,
    envelopeResponse,
    handleCapabilityRequest,
    isRegisteredCapabilityHttpPath,
    matchCapabilityRoute,
    resolveAppCapabilities,
  } = capabilityRuntime;
  const routePathname = ctx.routePathname;
  let capabilities: ResolvedCapability[] | null = hasCapabilities ? null : [];
  let capabilityResolutionError: unknown;
  try {
    if (hasCapabilities && !isMcpRequest) {
      capabilities = await resolveAppCapabilities(options.app, registry);
    }
  } catch (error: unknown) {
    capabilityResolutionError = error;
    warnCapabilityResolutionFailure(error);
    // A broken capability definition must not take down page rendering;
    // requests to capability paths still fail closed below.
    if (
      !isMcpRequest &&
      (routePathname.startsWith(CAPABILITY_HTTP_PREFIX) ||
        (await isRegisteredCapabilityHttpPath(options.app, registry, routePathname)))
    ) {
      return withDefaultSecurityHeaders(
        envelopeResponse(500, {
          ok: false,
          error: {
            code: "internal_error",
            message: ctx.exposeDiagnostics
              ? `Capability registry failed to resolve: ${error instanceof Error ? error.message : String(error)}`
              : "Capability registry failed to resolve.",
          },
        }),
      );
    }
  }

  if (isMcpRequest && ctx.mcpConfig && ctx.mcpRuntime) {
    const mcpResponse = await ctx.mcpRuntime.handleMcpRequest({
      app: options.app,
      capabilities: capabilities ?? [],
      loadCapabilities: hasCapabilities
        ? async () => {
            try {
              return await resolveAppCapabilities(options.app, registry);
            } catch (error: unknown) {
              warnCapabilityResolutionFailure(error);
              throw error;
            }
          }
        : undefined,
      context: ctx.context,
      registry,
      request,
      url,
      exposeErrors: ctx.exposeDiagnostics,
      mcp: ctx.mcpConfig,
      apiMiddlewareFiles: resolveApiMiddlewareFiles(options.app),
      agents: options.app.agents,
      agent: ctx.agent,
      onAudit: options.onCapabilityAudit,
      resolutionError: capabilityResolutionError,
    });
    return withDefaultSecurityHeaders(mcpResponse);
  }

  if (capabilities) {
    const capabilityMatch = matchCapabilityRoute(capabilities, routePathname);
    if (capabilityMatch) {
      // Same CSRF stance as state-changing API requests: capability calls
      // are session-authenticated POSTs, so cross-origin browser requests
      // are rejected unless the app opted out.
      const requireSameOrigin = options.app.api?.requireSameOrigin ?? true;
      if (
        requireSameOrigin &&
        !SAFE_METHODS.has(request.method) &&
        !isSameOriginRequest(request, url)
      ) {
        return withDefaultSecurityHeaders(
          envelopeResponse(403, {
            ok: false,
            error: { code: "cross_origin_blocked", message: "Cross-origin request blocked" },
          }),
        );
      }

      const capabilityResponse = await handleCapabilityRequest({
        match: capabilityMatch,
        context: ctx.context,
        registry,
        request,
        url,
        pathname: capabilityMatch.httpPath ?? routePathname,
        exposeErrors: ctx.exposeDiagnostics,
        apiMiddlewareFiles: resolveApiMiddlewareFiles(options.app),
        agents: options.app.agents,
        agent: ctx.agent,
        onAudit: options.onCapabilityAudit,
      });
      return withDefaultSecurityHeaders(
        withEnhancedCapabilityFormRedirect(capabilityResponse, request),
      );
    }

    // Unmatched requests under the capability prefix get the typed 404
    // instead of falling through to the HTML not-found page.
    if (routePathname.startsWith(CAPABILITY_HTTP_PREFIX)) {
      return withDefaultSecurityHeaders(
        envelopeResponse(404, {
          ok: false,
          error: {
            code: "unknown_capability",
            message: "No capability is exposed at this path.",
          },
        }),
      );
    }
  }

  return undefined;
}

/** Resolve an authoring-shaped manifest, passing an already-resolved one through. */
export function getResolvedApp(app: PrachtApp): ResolvedPrachtApp {
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

let warnedAgentSurfaceElided = false;

/** Build/runtime disagreement about the agent surface — log it once. */
function warnAgentSurfaceElided(): void {
  if (warnedAgentSurfaceElided) return;
  warnedAgentSurfaceElided = true;
  console.error(
    "[pracht] This build dropped the capability and agent-trust runtime because the app " +
      "manifest registered neither, but the running app has capabilities or an `agents` " +
      "config. Capability requests will 404 and agent signatures will not be verified. " +
      "Register capabilities as literal entries in `defineApp({ capabilities })` so the " +
      "build can see them, then rebuild.",
  );
}

let warnedCapabilityResolutionFailure = false;

/** Resolution failures repeat on every request — log the details once. */
function warnCapabilityResolutionFailure(error: unknown): void {
  if (warnedCapabilityResolutionFailure) return;
  warnedCapabilityResolutionFailure = true;
  console.error(
    "[pracht] Capability registry failed to resolve; capability requests will fail closed:",
    error,
  );
}

/**
 * Identity binding fails for the shape of the supplied context, so it fails on
 * every request until the adapter supplies a bindable one — log the details
 * once, since the 500 body stays generic in production.
 */
let warnedAgentContextBindingFailure = false;

function warnAgentContextBindingFailure(error: unknown): void {
  if (warnedAgentContextBindingFailure) return;
  warnedAgentContextBindingFailure = true;
  console.error(
    "[pracht] Verified agent identity could not be bound to the request context; " +
      "requests fail closed with a 500:",
    error,
  );
}
