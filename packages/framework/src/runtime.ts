import { h } from "preact";
import type { FunctionComponent } from "preact";

import { matchApiRoute, matchAppRoute, resolveApp } from "./app.ts";
import { ROUTE_STATE_REQUEST_HEADER, SAFE_METHODS } from "./runtime-constants.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import {
  resolveManifestEntries,
  resolvePageCssUrls,
  resolvePageJsUrls,
  resolveDataFunctions,
  resolveRegistryModule,
} from "./runtime-manifest.ts";
import {
  mergeDocumentHeaders,
  mergeHeadMetadata,
  runMiddlewareChain,
} from "./runtime-middleware.ts";
import {
  CAPABILITY_HTTP_PREFIX,
  envelopeResponse,
  handleCapabilityRequest,
  matchCapabilityRoute,
  resolveAppCapabilities,
  setActiveCapabilityHost,
  type ResolvedCapability,
} from "./runtime-capabilities.ts";
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
  HttpMethod,
  ModuleRegistry,
  HrefRouteDefinition,
  PrachtApp,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  RouteModule,
  ShellModule,
} from "./types.ts";

const SAME_ORIGIN_FETCH_SITE = "same-origin";

/**
 * Stricter variant of first-party detection used for CSRF protection on
 * state-changing API requests. It rejects any browser signal that points
 * outside this exact origin — a cross-origin form POST will send `Origin`
 * from the attacker, and `Sec-Fetch-Site: same-site` is not enough because
 * sibling subdomains can be attacker-controlled. Requests with no browser
 * provenance headers are treated as non-browser callers.
 */
function isSameOriginMutation(request: Request, url: URL): boolean {
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

  // Register the capability host so `invokeCapability()` works from loaders,
  // API routes, and middleware during this request. One assignment — free
  // for apps without capabilities.
  setActiveCapabilityHost(options.app, registry);

  if (options.apiRoutes?.length) {
    const apiMatch = matchApiRoute(options.apiRoutes, url.pathname);
    if (apiMatch) {
      const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
        const middlewareFile = options.app.middleware[name];
        return middlewareFile ? [middlewareFile] : [];
      });
      let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

      const requireSameOrigin = options.app.api.requireSameOrigin ?? true;
      if (
        requireSameOrigin &&
        !SAFE_METHODS.has(options.request.method) &&
        !isSameOriginMutation(options.request, url)
      ) {
        return withDefaultSecurityHeaders(
          new Response("Cross-origin request blocked", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }

      const requestSignal = AbortSignal.timeout(30_000);
      const apiContext = (options.context ?? {}) as TContext;

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
        return withDefaultSecurityHeaders(response);
      } catch (error: unknown) {
        return renderApiErrorResponse({
          error,
          middlewareFiles: apiMiddlewareFiles,
          options,
          phase: currentPhase,
          route: apiMatch.route,
        });
      }
    }
  }

  // Capability HTTP projection. Only runs when the manifest registers
  // capabilities — apps without them pay a single `Object.keys` call.
  // Explicit API route files take precedence (they matched above).
  if (Object.keys(options.app.capabilities ?? {}).length > 0) {
    let capabilities: ResolvedCapability[] | null = null;
    try {
      capabilities = await resolveAppCapabilities(options.app, registry);
    } catch (error: unknown) {
      warnCapabilityResolutionFailure(error);
      // A broken capability definition must not take down page rendering;
      // requests to capability paths still fail closed below.
      if (url.pathname.startsWith(CAPABILITY_HTTP_PREFIX)) {
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
          !isSameOriginMutation(options.request, url)
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
          context: (options.context ?? {}) as TContext,
          registry,
          request: options.request,
          url,
          exposeErrors: exposeDiagnostics,
        });
        return withDefaultSecurityHeaders(capabilityResponse);
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

  const requestSignal = AbortSignal.timeout(30_000);
  const pageContext = (options.context ?? {}) as TContext;
  const routeArgs: BaseRouteArgs<TContext> = {
    request: options.request,
    params: match.params,
    context: pageContext,
    signal: requestSignal,
    url,
    route: match.route,
  };
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
    const routeModulePromise = resolveRegistryModule<RouteModule>(
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
        throw new Error("Route module not found");
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
        return Response.json({ data });
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

      // Markdown-for-Agents negotiation must run after loader + header
      // resolution so auth redirects/401s and cache policies still apply.
      if (
        !isRouteStateRequest &&
        typeof routeModule.markdown === "string" &&
        prefersMarkdown(options.request.headers.get("accept"))
      ) {
        return markdownResponse(routeModule.markdown, documentHeaders);
      }

      const cssUrls = resolvePageCssUrls(
        options.cssManifest,
        match.route.shellFile,
        match.route.file,
      );
      const modulePreloadUrls = resolvePageJsUrls(
        options.jsManifest,
        match.route.shellFile,
        match.route.file,
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

        if (loadingTree) {
          const tree = h(
            PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
            {
              data: null,
              params: match.params,
              routeId: match.route.id ?? "",
              routes: resolvedApp.routes,
              url: requestPath,
            },
            loadingTree,
          );
          const renderFn = await getRenderToStringAsync();
          body = await renderFn(tree);
        }

        return htmlResponse(
          buildHtmlDocument({
            head,
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
          }),
          200,
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
        if (islandFiles.length > 0) {
          islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
          if (!islandsEntryUrl) {
            throw new Error(
              `Route "${match.route.path}" uses hydration: "islands" and rendered ` +
                `${islandFiles.length} island(s), but no islands bootstrap URL is registered. ` +
                "This usually means the @pracht/vite-plugin islands entry was not built — " +
                "check that your islands live in the configured islands directory.",
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
            head,
            body: ssrContent,
            clientEntryUrl: islandsEntryUrl,
            cssUrls,
            modulePreloadUrls: [...islandPreloadUrls],
          }),
          200,
          documentHeaders,
        );
      }

      return htmlResponse(
        buildHtmlDocument({
          head,
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
        }),
        200,
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
    return normalizePageResponse(response, { isRouteStateRequest });
  } catch (error: unknown) {
    return renderRouteErrorResponse({
      error,
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

let warnedCapabilityResolutionFailure = false;

/** Resolution failures repeat on every request — log the details once. */
function warnCapabilityResolutionFailure(error: unknown): void {
  if (warnedCapabilityResolutionFailure) return;
  warnedCapabilityResolutionFailure = true;
  console.error(
    "[pracht] Capability registry failed to resolve; capability requests will return 500:",
    error,
  );
}

function getRequestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function getResolvedApp(app: PrachtApp): ResolvedPrachtApp {
  const routes = (app as { routes: readonly unknown[] }).routes;
  if (routes.length === 0 || isHrefRouteDefinition(routes[0])) {
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
export { applyDefaultSecurityHeaders } from "./runtime-headers.ts";
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
  type FormProps,
  type LinkProps,
  type Location,
  type Navigation,
  type NavigationLocation,
  type PrachtHydrationState,
  type StartAppOptions,
} from "./runtime-hooks.ts";
export {
  fetchPrachtRouteState,
  parseSafeNavigationUrl,
  type RouteStateResult,
} from "./runtime-client-fetch.ts";
