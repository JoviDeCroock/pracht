import { h } from "preact";
import type { FunctionComponent } from "preact";
import { matchApiRoute, matchAppRoute, resolveApp } from "./app.ts";
import { collectFontHeadFragments } from "./font.ts";
import { ROUTE_STATE_REQUEST_HEADER, SAFE_METHODS } from "./runtime-constants.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  isPrachtHttpError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import {
  appendVaryHeader,
  withDefaultSecurityHeaders,
  withEnhancedCapabilityFormRedirect,
} from "./runtime-headers.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import { createScriptCapture, ScriptCaptureContext, withCapturedScripts } from "./script.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
  resolvePageCssUrls,
  resolvePageJsUrls,
  resolveDataFunctions,
  resolveRegistryModule,
} from "./runtime-manifest.ts";
import {
  mergeDocumentHeaders,
  mergeErrorHeadMetadata,
  mergeHeadMetadata,
  runMiddlewareChain,
} from "./runtime-middleware.ts";
import type { ResolvedCapability } from "./runtime-capabilities.ts";
import { buildRouteStateUrl } from "./runtime-client-fetch.ts";
import {
  getRenderToStringAsync,
  jsonErrorResponse,
  normalizePageResponse,
  renderApiErrorResponse,
  renderRouteErrorResponse,
} from "./runtime-response.ts";
import { withRouteResponseHeaders } from "./runtime-headers.ts";
import { markdownResponse, prefersMarkdown } from "./runtime-negotiation.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  ApiRouteArgs,
  ApiRouteModule,
  BaseRouteArgs,
  CapabilityAuditHook,
  HttpMethod,
  ModuleRegistry,
  HrefRouteDefinition,
  PrachtAgentIdentity,
  PrachtApp,
  PrachtContextExtensions,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
} from "./types.ts";

const SAME_ORIGIN_FETCH_SITE = "same-origin";

const BODY_REPRESENTATION_HEADERS = [
  "content-digest",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "digest",
  "etag",
  "repr-digest",
  "transfer-encoding",
] as const;

function headersForReserializedBody(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  for (const name of BODY_REPRESENTATION_HEADERS) nextHeaders.delete(name);
  return nextHeaders;
}

async function attachFontHeadToRouteStateResponse<TContext>(options: {
  response: Response;
  isRouteStateRequest: boolean;
  routeArgs: BaseRouteArgs<TContext>;
  routeModule: RouteModule | undefined | Promise<RouteModule | undefined>;
  shellModule: ShellModule | undefined | Promise<ShellModule | undefined>;
}): Promise<Response> {
  const { response, isRouteStateRequest, routeArgs } = options;
  if (!isRouteStateRequest) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const payload = (await response.clone().json()) as unknown;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return response;

  const body = payload as Record<string, unknown>;
  if (Object.hasOwn(body, "fontHead") || typeof body.redirect === "string") return response;

  const [routeModule, shellModule] = await Promise.all([options.routeModule, options.shellModule]);
  const data = body.data;
  const head =
    response.ok && !Object.hasOwn(body, "error")
      ? await mergeHeadMetadata(shellModule, routeModule, routeArgs, data)
      : await mergeErrorHeadMetadata(shellModule, routeModule, routeArgs);
  const fontHead = collectFontHeadFragments(head.fonts ?? []);
  return Response.json(
    {
      ...body,
      fontHead,
    },
    {
      status: response.status,
      statusText: response.statusText,
      headers: headersForReserializedBody(response.headers),
    },
  );
}

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
function isSameOriginRequest(request: Request, url: URL): boolean {
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

  let requestContext = (options.context ?? {}) as TContext & PrachtContextExtensions;
  const hasCapabilities = Object.keys(options.app.capabilities ?? {}).length > 0;
  const mcpConfig = options.app.agents?.mcp;
  let capabilityRuntime: typeof import("./runtime-capabilities.ts") | null = null;
  let mcpRuntime: typeof import("./runtime-mcp.ts") | null = null;
  let agent: PrachtAgentIdentity | null = null;

  // The agent surface loads on demand: apps that register no capabilities and
  // configure no agents never import either module, and builds that can prove
  // it statically drop them from the bundle outright.
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
        return withDefaultSecurityHeaders(
          new Response(
            exposeDiagnostics
              ? `Request context could not carry verified agent identity: ${
                  error instanceof Error ? error.message : String(error)
                }`
              : "Internal Server Error",
            { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
          ),
        );
      }
      agent = requestContext.agent ?? null;
    }

    // Register the request so `invokeCapability()` works from loaders, API
    // routes, and middleware. An actual MCP dispatch replaces this provenance
    // after explicit API-route precedence has been resolved below.
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

  if (options.apiRoutes?.length) {
    const apiMatch = matchApiRoute(options.apiRoutes, url.pathname);
    if (apiMatch) {
      const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
        const middlewareFile = options.app.middleware[name];
        return middlewareFile ? [middlewareFile] : [];
      });
      let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

      if (
        requireSameOrigin &&
        !SAFE_METHODS.has(options.request.method) &&
        !isSameOriginRequest(options.request, url)
      ) {
        return withDefaultSecurityHeaders(
          new Response("Cross-origin request blocked", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }

      const requestSignal = AbortSignal.timeout(30_000);
      const apiContext = requestContext;

      const apiTerminal = async (): Promise<Response> => {
        currentPhase = "api";
        const apiModule = await resolveRegistryModule<ApiRouteModule>(
          registry.apiModules,
          apiMatch.route.file,
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

        const apiRouteArgs: ApiRouteArgs<TContext> = {
          request: options.request,
          params: apiMatch.params,
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
          registry,
          request: options.request,
          route: apiMatch.route,
          signal: requestSignal,
          url,
          terminal: apiTerminal,
        });
        return withDefaultSecurityHeaders(
          withEnhancedCapabilityFormRedirect(response, options.request),
        );
      } catch (error: unknown) {
        // Same short-circuit contract as page loaders: a thrown `Response` is
        // the handler answering, not failing. Guarded because this runs inside
        // the catch, where a further throw would reject out of
        // `handlePrachtRequest` instead of becoming a 500.
        let thrownResponseFailure: unknown;
        if (error instanceof Response) {
          try {
            return withDefaultSecurityHeaders(
              withEnhancedCapabilityFormRedirect(error, options.request),
            );
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
  }

  // Capability projections. Explicit API route files take precedence (they
  // matched above). A configured MCP endpoint remains live with an empty or
  // broken graph so clients receive an empty list or a protocol error instead
  // of falling through to the application's page router.
  const isMcpRequest =
    !!mcpConfig &&
    !!mcpRuntime &&
    mcpRuntime.normalizeMcpRequestPath(url.pathname) ===
      mcpRuntime.resolveMcpEndpoint(options.app.agents);
  if (capabilityRuntime && (hasCapabilities || isMcpRequest)) {
    if (isMcpRequest) {
      // Adapter contexts may retain the incoming transport request. Bind the
      // same trusted provenance as the synthesized capability request so that
      // using either request for composition preserves the MCP guard.
      capabilityRuntime.setActiveCapabilityHost(
        options.request,
        options.app,
        registry,
        "mcp",
        options.onCapabilityAudit,
        agent,
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
    let capabilities: ResolvedCapability[] | null = hasCapabilities ? null : [];
    let capabilityResolutionError: unknown;
    try {
      if (hasCapabilities) {
        capabilities = await resolveAppCapabilities(options.app, registry);
      }
    } catch (error: unknown) {
      capabilityResolutionError = error;
      warnCapabilityResolutionFailure(error);
      // A broken capability definition must not take down page rendering;
      // requests to capability paths still fail closed below.
      if (
        !isMcpRequest &&
        (url.pathname.startsWith(CAPABILITY_HTTP_PREFIX) ||
          (await isRegisteredCapabilityHttpPath(options.app, registry, url.pathname)))
      ) {
        return withDefaultSecurityHeaders(
          envelopeResponse(500, {
            ok: false,
            error: {
              code: "internal_error",
              message: exposeDiagnostics
                ? `Capability registry failed to resolve: ${error instanceof Error ? error.message : String(error)}`
                : "Capability registry failed to resolve.",
            },
          }),
        );
      }
    }

    if (isMcpRequest && mcpConfig && mcpRuntime) {
      const mcpResponse = await mcpRuntime.handleMcpRequest({
        app: options.app,
        capabilities: capabilities ?? [],
        context: requestContext,
        registry,
        request: options.request,
        url,
        exposeErrors: exposeDiagnostics,
        mcp: mcpConfig,
        apiMiddlewareFiles: (options.app.api.middleware ?? []).flatMap((name) => {
          const middlewareFile = options.app.middleware[name];
          return middlewareFile ? [middlewareFile] : [];
        }),
        agents: options.app.agents,
        agent,
        onAudit: options.onCapabilityAudit,
        resolutionError: capabilityResolutionError,
      });
      return withDefaultSecurityHeaders(mcpResponse);
    }

    if (capabilities) {
      const capabilityMatch = matchCapabilityRoute(capabilities, url.pathname);
      if (capabilityMatch) {
        // Same CSRF stance as state-changing API requests: capability calls
        // are session-authenticated POSTs, so cross-origin browser requests
        // are rejected unless the app opted out.
        const requireSameOrigin = options.app.api?.requireSameOrigin ?? true;
        if (
          requireSameOrigin &&
          !SAFE_METHODS.has(options.request.method) &&
          !isSameOriginRequest(options.request, url)
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
          context: requestContext,
          registry,
          request: options.request,
          url,
          exposeErrors: exposeDiagnostics,
          apiMiddlewareFiles: (options.app.api.middleware ?? []).flatMap((name) => {
            const middlewareFile = options.app.middleware[name];
            return middlewareFile ? [middlewareFile] : [];
          }),
          agents: options.app.agents,
          agent,
          onAudit: options.onCapabilityAudit,
        });
        return withDefaultSecurityHeaders(
          withEnhancedCapabilityFormRedirect(capabilityResponse, options.request),
        );
      }

      // Unmatched requests under the capability prefix get the typed 404
      // instead of falling through to the HTML not-found page.
      if (url.pathname.startsWith(CAPABILITY_HTTP_PREFIX)) {
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
  }

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
      return renderPageMatch(notFoundMatch, { isNotFoundPage: true, status: 404 });
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

  return renderPageMatch(match, { isNotFoundPage: false, status: 200 });

  /**
   * Render one page match through the middleware → loader → render pipeline.
   *
   * `status` is the success status of the rendered document (200 for a normal
   * route, 404 for the not-found page). `isNotFoundPage` marks a render that
   * is already the not-found page, so a 404 thrown from *its* loader cannot
   * re-enter this path.
   */
  async function renderPageMatch(
    match: RouteMatch,
    pageOptions: { isNotFoundPage: boolean; status: number },
  ): Promise<Response> {
    const requestSignal = AbortSignal.timeout(30_000);
    const pageContext = requestContext;
    const routeArgs: BaseRouteArgs<TContext> = {
      request: options.request,
      params: match.params,
      context: pageContext,
      signal: requestSignal,
      url,
      route: match.route,
    };
    let routeModulePromise: Promise<RouteModule | undefined> | undefined;
    let routeModule: RouteModule | undefined;
    let shellModule: ShellModule | undefined;
    let loaderFile: string | undefined;
    let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";
    const timings = options.timings;

    try {
      // Kick off every piece of the pipeline that doesn't depend on the
      // middleware chain's result up front, so they run concurrently with
      // middleware rather than waiting in line:
      //
      //   • route module import                          (needs only match.route.file)
      //   • shell module import                          (needs only match.route.shellFile)
      //   • data-module resolution (separate loader file) (needs routeModule)
      //
      // Only the loader itself still waits for middleware, because it
      // receives the (potentially middleware-mutated) context.
      routeModulePromise = resolveRegistryModule<RouteModule>(
        registry.routeModules,
        match.route.file,
      );

      const shellModulePromise: Promise<ShellModule | undefined> = match.route.shellFile
        ? resolveRegistryModule<ShellModule>(registry.shellModules, match.route.shellFile)
        : Promise.resolve(undefined);

      const dataFunctionsPromise = routeModulePromise.then((mod) =>
        resolveDataFunctions(match.route, mod, registry),
      );

      // Suppress unhandled-rejection warnings for in-flight promises that we
      // may not reach (e.g. middleware short-circuits with a response). Each
      // promise is still awaited via the original reference below, so real
      // errors still surface through the existing try/catch.
      routeModulePromise.catch(() => {});
      shellModulePromise.catch(() => {});
      dataFunctionsPromise.catch(() => {});

      const pageTerminal = async (): Promise<Response> => {
        currentPhase = "render";
        routeModule = await routeModulePromise;
        if (!routeModule) {
          throw new Error(
            pageOptions.isNotFoundPage
              ? `notFound page module ${JSON.stringify(match.route.file)} was not found in the module registry. ` +
                  "The not-found page is loaded from the same registry as route modules, so it has to live in the routes directory."
              : "Route module not found",
          );
        }

        currentPhase = "loader";
        const { loader, loaderFile: resolvedLoaderFile } = await dataFunctionsPromise;
        loaderFile = resolvedLoaderFile;

        let loaderResult: unknown;
        if (loader) {
          const loaderStart = timings ? performance.now() : 0;
          try {
            loaderResult = await loader(routeArgs);
          } catch (error: unknown) {
            // A thrown Response is the loader's answer, just like a returned
            // Response. Normalize both through the same route-state path so
            // redirects, cache headers, and font metadata cannot diverge.
            if (!(error instanceof Response)) throw error;
            loaderResult = error;
          }
          if (timings) {
            timings.loader = performance.now() - loaderStart;
          }
        }

        // Allow loaders to return a Response directly (e.g. for redirects)
        if (loaderResult instanceof Response) {
          return loaderResult;
        }

        const data = loaderResult;

        if (isRouteStateRequest) {
          // Route head exports are stripped from the client bundle. Return the
          // generated font fragments with loader data so client navigation can
          // keep route-scoped font registrations in sync with full documents.
          shellModule = await shellModulePromise;
          const head = await mergeHeadMetadata(shellModule, routeModule, routeArgs, data);
          const fontHead = collectFontHeadFragments(head.fonts ?? []);
          const body = { data, fontHead };
          return withRouteResponseHeaders(Response.json(body), {
            isRouteStateRequest: true,
            loaderCache: match.route.loaderCache,
          });
        }

        // Shell import was kicked off up front; this await is usually already
        // resolved by the time we get here (it runs in parallel with the loader).
        currentPhase = "render";
        shellModule = await shellModulePromise;

        // head and document headers are independent; run them concurrently.
        const [head, documentHeaders] = await Promise.all([
          mergeHeadMetadata(shellModule, routeModule, routeArgs, data),
          mergeDocumentHeaders(shellModule, routeModule, routeArgs, data),
        ]);

        // Both representations must carry the same Vary header so a cache
        // filled by an HTML request can never satisfy a later markdown request
        // (or vice versa). Keep the variance scoped to routes that actually
        // export markdown: raw Accept values create distinct cache variants on
        // CDNs such as Cloudflare Workers Caching.
        const markdownRepresentation =
          typeof routeModule.markdown === "string" ? routeModule.markdown : undefined;
        if (markdownRepresentation !== undefined) {
          appendVaryHeader(documentHeaders, "Accept");
        }

        // Markdown-for-Agents negotiation must run after loader + header
        // resolution so auth redirects/401s and cache policies still apply.
        if (
          !isRouteStateRequest &&
          markdownRepresentation !== undefined &&
          prefersMarkdown(options.request.headers.get("accept"))
        ) {
          return markdownResponse(markdownRepresentation, documentHeaders, pageOptions.status);
        }

        const cssUrls = resolvePageCssUrls(
          options.cssManifest,
          match.route.shellFile,
          match.route.file,
        );
        const modulePreloadUrls = mergeEntryPreloadUrls(
          options.jsManifest,
          CLIENT_ENTRY_MANIFEST_KEY,
          resolvePageJsUrls(options.jsManifest, match.route.shellFile, match.route.file),
        );

        if (match.route.render === "spa") {
          let body = "";
          const Shell = shellModule?.Shell as FunctionComponent | undefined;
          const Loading = shellModule?.Loading as FunctionComponent | undefined;
          const loadingTree =
            Shell != null
              ? h(Shell, null, Loading ? h(Loading, null) : null)
              : Loading
                ? h(Loading, null)
                : null;

          // SPA shells render on the server too (the loading tree), so a
          // <Script strategy="beforeHydration"> inside the shell still lands
          // in the document head.
          const spaScriptCapture = createScriptCapture("full");
          if (loadingTree) {
            const tree = h(
              ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
              { value: spaScriptCapture },
              h(
                PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
                {
                  data: null,
                  params: match.params,
                  routeId: match.route.id ?? "",
                  routes: resolvedApp.routes,
                  url: requestPath,
                },
                loadingTree,
              ),
            );
            const renderFn = await getRenderToStringAsync();
            body = await renderFn(tree);
          }

          return htmlResponse(
            buildHtmlDocument({
              head: withCapturedScripts(head, spaScriptCapture),
              body,
              hydrationState: {
                url: requestPath,
                routeId: match.route.id ?? "",
                data: null,
                error: null,
                pending: true,
              },
              clientEntryUrl: options.clientEntryUrl,
              cssUrls,
              modulePreloadUrls,
              routeStatePreloadUrl: loader ? buildRouteStateUrl(requestPath) : undefined,
              speculationRules: getAppSpeculationRules(resolvedApp),
            }),
            pageOptions.status,
            documentHeaders,
          );
        }

        const DefaultComponent =
          typeof routeModule.default === "function" ? routeModule.default : undefined;
        const Component = (routeModule.Component ?? DefaultComponent) as
          | FunctionComponent
          | undefined;
        if (!Component) {
          throw new Error("Route has no Component or default export");
        }

        const Shell = shellModule?.Shell as FunctionComponent<Record<string, unknown>> | undefined;
        const Comp = Component as FunctionComponent<Record<string, unknown>>;
        const componentProps = { data, params: match.params };

        const componentTree = Shell
          ? h(Shell, null, h(Comp, componentProps))
          : h(Comp, componentProps);

        let tree = h(
          PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
          {
            data,
            params: match.params,
            routeId: match.route.id ?? "",
            routes: resolvedApp.routes,
            url: requestPath,
          },
          componentTree,
        );

        const hydration = match.route.hydration ?? "full";

        // <Script strategy="beforeHydration"> usages captured during the
        // render land in the document head after head() scripts. The capture
        // travels through context (not module state), so concurrent async
        // renders — e.g. parallel SSG prerendering — never attribute scripts
        // to the wrong page.
        const scriptCapture = createScriptCapture(hydration);
        tree = h(
          ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
          { value: scriptCapture },
          tree,
        );

        let islandCapture: IslandCapture | null = null;
        if (hydration === "islands") {
          // The capture collector travels through context (not module state),
          // so concurrent async renders — e.g. parallel SSG prerendering —
          // never attribute islands to the wrong page.
          islandCapture = { islands: [] };
          tree = h(
            IslandCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
            { value: islandCapture },
            tree,
          );
        }

        const renderToString = await getRenderToStringAsync();
        const ssrContent = await renderToString(tree);

        if (hydration !== "full") {
          const islandFiles = [
            ...new Set((islandCapture?.islands ?? []).map((usage) => usage.descriptor.file)),
          ];
          let islandsEntryUrl: string | undefined;
          const needsIslandsBootstrap =
            hydration === "islands" &&
            (islandFiles.length > 0 || options.islandsBootstrapRequired === true);
          if (needsIslandsBootstrap) {
            islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
            if (!islandsEntryUrl) {
              throw new Error(
                `Route "${match.route.path}" uses hydration: "islands" and requires the ` +
                  `islands bootstrap${islandFiles.length > 0 ? ` for ${islandFiles.length} rendered island(s)` : " for a page-level runtime projection"}, but no bootstrap URL is registered. ` +
                  (islandFiles.length > 0
                    ? "This usually means the @pracht/vite-plugin islands entry was not built — check that your islands live in the configured islands directory."
                    : "This usually means generated page-runtime metadata was not forwarded by the deployment adapter."),
              );
            }
          }

          // Preload only islands that hydrate immediately ("load"). Preloading
          // "visible"/"idle" islands would defeat those strategies' whole
          // point: deferring the network cost until the island is needed.
          const preloadFiles = new Set(
            (islandCapture?.islands ?? [])
              .filter((usage) => usage.strategy === "load")
              .map((usage) => usage.descriptor.file),
          );
          const islandPreloadUrls = new Set<string>();
          if (options.jsManifest) {
            for (const file of preloadFiles) {
              for (const url of resolveManifestEntries(options.jsManifest, file) ?? []) {
                islandPreloadUrls.add(url);
              }
            }
          }

          // No hydration state, no client runtime: islands routes ship only the
          // islands bootstrap plus the islands present on the page, and
          // hydration: "none" routes ship no JavaScript at all.
          return htmlResponse(
            buildHtmlDocument({
              head: withCapturedScripts(head, scriptCapture),
              body: ssrContent,
              clientEntryUrl: islandsEntryUrl,
              cssUrls,
              modulePreloadUrls: islandsEntryUrl
                ? mergeEntryPreloadUrls(options.jsManifest, ISLANDS_ENTRY_MANIFEST_KEY, [
                    ...islandPreloadUrls,
                  ])
                : [...islandPreloadUrls],
              speculationRules: getAppSpeculationRules(resolvedApp),
            }),
            pageOptions.status,
            documentHeaders,
          );
        }

        return htmlResponse(
          buildHtmlDocument({
            head: withCapturedScripts(head, scriptCapture),
            body: ssrContent,
            hydrationState: {
              url: requestPath,
              routeId: match.route.id ?? "",
              data,
              error: null,
            },
            clientEntryUrl: options.clientEntryUrl,
            cssUrls,
            modulePreloadUrls,
            speculationRules: getAppSpeculationRules(resolvedApp),
          }),
          pageOptions.status,
          documentHeaders,
        );
      };

      // Dev-only instrumentation: wrap the terminal so middleware time can be
      // derived as "chain total minus terminal", and terminal time minus the
      // loader becomes the render phase. Production passes no collector and
      // uses the un-wrapped terminal.
      let terminal = pageTerminal;
      let chainStart = 0;
      if (timings) {
        terminal = async () => {
          const terminalStart = performance.now();
          try {
            return await pageTerminal();
          } finally {
            timings.render = performance.now() - terminalStart - (timings.loader ?? 0);
          }
        };
        chainStart = performance.now();
      }

      const response = await runMiddlewareChain({
        context: pageContext,
        middlewareFiles: match.route.middlewareFiles,
        params: match.params,
        registry,
        request: options.request,
        route: match.route,
        signal: requestSignal,
        url,
        terminal,
      });
      if (timings) {
        timings.mw = performance.now() - chainStart - (timings.render ?? 0) - (timings.loader ?? 0);
      }
      const normalizedResponse = normalizePageResponse(response, {
        isRouteStateRequest,
        loaderCache: match.route.loaderCache,
        markdown: match.route.markdown,
      });
      return await attachFontHeadToRouteStateResponse({
        response: normalizedResponse,
        isRouteStateRequest,
        routeArgs,
        routeModule: routeModulePromise,
        shellModule: shellModulePromise,
      });
    } catch (error: unknown) {
      // A thrown `Response` is a deliberate short-circuit, not a failure: it is
      // how a loader aborts its own render to redirect (`throw redirect(...)`)
      // or answer directly, which returning cannot express from inside a helper
      // the loader called. Same value either way, so it takes the same path a
      // returned `Response` does.
      //
      // Normalizing here means normalizing *inside* the catch, where a throw
      // has nothing left to catch it and would reject out of
      // `handlePrachtRequest` — an unhandled rejection in the adapter, not a
      // 500. A shared module-scope `Response` with a body delivered twice does
      // exactly that (the second read finds the body disturbed), so failures
      // fall through to the error renderer like any other loader fault.
      let thrownResponseFailure: unknown;
      if (error instanceof Response) {
        try {
          return normalizePageResponse(error, {
            isRouteStateRequest,
            loaderCache: match.route.loaderCache,
            markdown: match.route.markdown,
          });
        } catch (normalizeError: unknown) {
          thrownResponseFailure = normalizeError;
        }
      }

      // A 404 thrown by a loader or middleware (`throw notFound()`) is not a
      // crash — it means "this URL has no content". Render the app-level
      // not-found page for it, unless the route declares its own
      // ErrorBoundary (the more specific handler wins) or we are already
      // rendering the not-found page.
      if (!pageOptions.isNotFoundPage && isNotFoundError(error) && !isRouteStateRequest) {
        const notFoundMatch = createNotFoundMatch(resolvedApp, url.pathname);
        if (notFoundMatch) {
          const module = routeModule ?? (await routeModulePromise?.catch(() => undefined));
          if (!module?.ErrorBoundary) {
            return renderPageMatch(notFoundMatch, { isNotFoundPage: true, status: 404 });
          }
        }
      }

      // Middleware can fail before pageTerminal assigns routeModule. The import
      // was still started in parallel, so retain route-scoped error metadata
      // (notably fonts used by the route ErrorBoundary) when it resolves.
      routeModule ??= await routeModulePromise?.catch(() => undefined);

      return renderRouteErrorResponse({
        error: thrownResponseFailure ?? error,
        isRouteStateRequest,
        loaderFile,
        options,
        phase: currentPhase,
        routeArgs,
        routeId: match.route.id ?? "",
        routeModule,
        routes: resolvedApp.routes,
        shellFile: match.route.shellFile,
        shellModule,
        requestPath,
      });
    }
  }
}

/**
 * A `RouteMatch` for the app-level not-found page, or `undefined` when the
 * app declares none. `pathname` is the request path so diagnostics and
 * `useLocation()` still report where the visitor actually landed.
 */
function createNotFoundMatch(app: ResolvedPrachtApp, pathname: string): RouteMatch | undefined {
  const route = app.notFound;
  if (!route || !("segments" in route)) return undefined;
  return { route, params: {}, pathname };
}

function isNotFoundError(error: unknown): boolean {
  return isPrachtHttpError(error) && error.status === 404;
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
