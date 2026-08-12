/**
 * Page middleware, loading, and rendering pipeline.
 *
 * Module imports begin concurrently with middleware execution. The loader
 * waits for middleware because it observes the shared request context, then
 * representation rendering receives only settled page data and metadata.
 */

import { isPrachtHttpError, type PrachtRuntimeDiagnosticPhase } from "./runtime-errors.ts";
import { withRouteResponseHeaders } from "./runtime-headers.ts";
import { resolveDataFunctions, resolveRegistryModule } from "./runtime-manifest.ts";
import {
  mergeDocumentHeaders,
  mergeHeadMetadata,
  runMiddlewareChain,
} from "./runtime-middleware.ts";
import { renderPageRepresentation } from "./runtime-page-render.ts";
import { normalizePageResponse, renderRouteErrorResponse } from "./runtime-response.ts";
import type { PrachtPhaseTimings } from "./runtime-timing.ts";
import type {
  BaseRouteArgs,
  ModuleRegistry,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
} from "./types.ts";

export interface ExecutePageMatchOptions<TContext> {
  clientEntryUrl?: string;
  context: TContext;
  cssManifest?: Record<string, string[]>;
  debugErrors?: boolean;
  islandsBootstrapRequired?: boolean;
  islandsEntryUrl?: string;
  isNotFoundPage: boolean;
  isRouteStateRequest: boolean;
  jsManifest?: Record<string, string[]>;
  match: RouteMatch;
  registry: ModuleRegistry;
  request: Request;
  requestPath: string;
  resolvedApp: ResolvedPrachtApp;
  status: number;
  timings?: PrachtPhaseTimings;
  url: URL;
}

/** Execute one resolved page through middleware, loader, and representation rendering. */
export async function executePageMatch<TContext>(
  options: ExecutePageMatchOptions<TContext>,
): Promise<Response> {
  const { match } = options;
  const signal = AbortSignal.timeout(30_000);
  const routeArgs: BaseRouteArgs<TContext> = {
    request: options.request,
    params: match.params,
    context: options.context,
    signal,
    url: options.url,
    route: match.route,
  };
  let routeModulePromise: Promise<RouteModule | undefined> | undefined;
  let routeModule: RouteModule | undefined;
  let shellModule: ShellModule | undefined;
  let loaderFile: string | undefined;
  let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";
  const { timings } = options;

  try {
    // Start imports that do not depend on middleware up front. Only loader
    // execution waits because middleware may mutate the shared context.
    routeModulePromise = resolveRegistryModule<RouteModule>(
      options.registry.routeModules,
      match.route.file,
    );
    const shellModulePromise: Promise<ShellModule | undefined> = match.route.shellFile
      ? resolveRegistryModule<ShellModule>(options.registry.shellModules, match.route.shellFile)
      : Promise.resolve(undefined);
    const dataFunctionsPromise = routeModulePromise.then((module) =>
      resolveDataFunctions(match.route, module, options.registry),
    );

    // Middleware can short-circuit before these promises are awaited. Attach
    // rejection handlers now while still awaiting the originals on the normal
    // path so real failures reach the pipeline catch below.
    routeModulePromise.catch(() => {});
    shellModulePromise.catch(() => {});
    dataFunctionsPromise.catch(() => {});

    const pageTerminal = async (): Promise<Response> => {
      currentPhase = "render";
      routeModule = await routeModulePromise;
      if (!routeModule) {
        throw new Error(
          options.isNotFoundPage
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
        if (timings) timings.loader = performance.now() - loaderStart;
      }
      if (loaderResult instanceof Response) return loaderResult;

      const data = loaderResult;
      if (options.isRouteStateRequest) {
        return withRouteResponseHeaders(Response.json({ data }), {
          isRouteStateRequest: true,
          loaderCache: match.route.loaderCache,
        });
      }

      currentPhase = "render";
      shellModule = await shellModulePromise;
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
        requestPath: options.requestPath,
        resolvedApp: options.resolvedApp,
        routeModule,
        shellModule,
        status: options.status,
      });
    };

    // Timing is opt-in. Middleware time is the whole chain minus loader and
    // render work performed by the terminal.
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
      context: options.context,
      middlewareFiles: match.route.middlewareFiles,
      params: match.params,
      registry: options.registry,
      request: options.request,
      route: match.route,
      signal,
      url: options.url,
      terminal,
    });
    if (timings) {
      timings.mw = performance.now() - chainStart - (timings.render ?? 0) - (timings.loader ?? 0);
    }
    return normalizePageResponse(response, {
      isRouteStateRequest: options.isRouteStateRequest,
      loaderCache: match.route.loaderCache,
      markdown: match.route.markdown,
    });
  } catch (error: unknown) {
    // A thrown Response is a deliberate redirect/direct answer. Normalization
    // itself may fail for a reused disturbed body; that becomes a renderable
    // route error rather than escaping the adapter as a rejected promise.
    let thrownResponseFailure: unknown;
    if (error instanceof Response) {
      try {
        return normalizePageResponse(error, {
          isRouteStateRequest: options.isRouteStateRequest,
          loaderCache: match.route.loaderCache,
          markdown: match.route.markdown,
        });
      } catch (normalizeError: unknown) {
        thrownResponseFailure = normalizeError;
      }
    }

    // A route-level ErrorBoundary wins. Otherwise a thrown 404 enters the
    // app-level not-found page once, never recursively from that page itself.
    if (!options.isNotFoundPage && isNotFoundError(error) && !options.isRouteStateRequest) {
      const notFoundMatch = createNotFoundMatch(options.resolvedApp, options.url.pathname);
      if (notFoundMatch) {
        const module = routeModule ?? (await routeModulePromise?.catch(() => undefined));
        if (!module?.ErrorBoundary) {
          return executePageMatch({
            ...options,
            isNotFoundPage: true,
            match: notFoundMatch,
            status: 404,
          });
        }
      }
    }

    return renderRouteErrorResponse({
      error: thrownResponseFailure ?? error,
      isRouteStateRequest: options.isRouteStateRequest,
      loaderFile,
      options,
      phase: currentPhase,
      routeArgs,
      routeId: match.route.id ?? "",
      routeModule,
      routes: options.resolvedApp.routes,
      shellFile: match.route.shellFile,
      shellModule,
      requestPath: options.requestPath,
    });
  }
}

/** Build a match for the app-level not-found page without entering route matching. */
export function createNotFoundMatch(
  app: ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const route = app.notFound;
  if (!route || !("segments" in route)) return undefined;
  return { route, params: {}, pathname };
}

function isNotFoundError(error: unknown): boolean {
  return isPrachtHttpError(error) && error.status === 404;
}
