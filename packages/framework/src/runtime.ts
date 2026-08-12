import { matchAppRoute, resolveApp } from "./app.ts";
import { dispatchAgentProjection } from "./runtime-agent-projection.ts";
import { AGENT_SURFACE_ENABLED, initializeAgentSurface } from "./runtime-agent-surface.ts";
import { dispatchApiRequest } from "./runtime-api.ts";
import { ROUTE_STATE_REQUEST_HEADER, SAFE_METHODS } from "./runtime-constants.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  isPrachtHttpError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { resolveDataFunctions, resolveRegistryModule } from "./runtime-manifest.ts";
import {
  mergeDocumentHeaders,
  mergeHeadMetadata,
  runMiddlewareChain,
} from "./runtime-middleware.ts";
import { renderPageRepresentation } from "./runtime-page-render.ts";
import { isFirstPartyFetch, isSameOriginRequest } from "./runtime-request-provenance.ts";
import {
  jsonErrorResponse,
  normalizePageResponse,
  renderRouteErrorResponse,
} from "./runtime-response.ts";
import { withRouteResponseHeaders } from "./runtime-headers.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  BaseRouteArgs,
  CapabilityAuditHook,
  ModuleRegistry,
  HrefRouteDefinition,
  PrachtApp,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
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
          loaderResult = await loader(routeArgs);
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
          return withRouteResponseHeaders(Response.json({ data }), {
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

        return renderPageRepresentation({
          clientEntryUrl: options.clientEntryUrl,
          cssManifest: options.cssManifest,
          data,
          documentHeaders,
          hasLoader: Boolean(loader),
          head,
          islandsBootstrapRequired: options.islandsBootstrapRequired,
          islandsEntryUrl: options.islandsEntryUrl,
          jsManifest: options.jsManifest,
          match,
          request: options.request,
          requestPath,
          resolvedApp,
          routeModule,
          shellModule,
          status: pageOptions.status,
        });
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
      return normalizePageResponse(response, {
        isRouteStateRequest,
        loaderCache: match.route.loaderCache,
        markdown: match.route.markdown,
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
