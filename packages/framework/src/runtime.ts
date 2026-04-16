import { h } from "preact";
import type { FunctionComponent } from "preact";

import { matchApiRoute, matchAppRoute } from "./app.ts";
import { ROUTE_STATE_REQUEST_HEADER, SAFE_METHODS } from "./runtime-constants.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { PrachtRuntimeProvider } from "./runtime-hooks.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
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
import { buildRouteStateUrl } from "./runtime-client-fetch.ts";
import {
  getRenderToStringAsync,
  jsonErrorResponse,
  normalizePageResponse,
  renderApiErrorResponse,
  renderRouteErrorResponse,
} from "./runtime-response.ts";
import { withRouteResponseHeaders } from "./runtime-headers.ts";
import type {
  ApiRouteArgs,
  ApiRouteModule,
  BaseRouteArgs,
  HttpMethod,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
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
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
  /** Per-source-file JS chunk map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  apiRoutes?: ResolvedApiRoute[];
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
  const isRouteStateRequest =
    options.request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || hasDataParam;
  const exposeDiagnostics = shouldExposeServerErrors(options);

  if (options.apiRoutes?.length) {
    const apiMatch = matchApiRoute(options.apiRoutes, url.pathname);
    if (apiMatch) {
      const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
        const middlewareFile = options.app.middleware[name];
        return middlewareFile ? [middlewareFile] : [];
      });
      let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

      try {
        const middlewareResult = await runMiddlewareChain({
          context: (options.context ?? {}) as TContext,
          middlewareFiles: apiMiddlewareFiles,
          params: apiMatch.params,
          registry,
          request: options.request,
          route: apiMatch.route,
          url,
        });
        if (middlewareResult.response) {
          return middlewareResult.response;
        }

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
          return withDefaultSecurityHeaders(
            new Response("Method not allowed", {
              status: 405,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }),
          );
        }

        const apiRouteArgs: ApiRouteArgs<TContext> = {
          request: options.request,
          params: apiMatch.params,
          context: middlewareResult.context,
          signal: AbortSignal.timeout(30_000),
          url,
          route: apiMatch.route,
        };

        return withDefaultSecurityHeaders(await handler(apiRouteArgs));
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

  const match = matchAppRoute(options.app, url.pathname);

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

  let routeArgs: BaseRouteArgs<TContext> = {
    request: options.request,
    params: match.params,
    context: (options.context ?? {}) as TContext,
    signal: AbortSignal.timeout(30_000),
    url,
    route: match.route,
  };
  let routeModule: RouteModule | undefined;
  let shellModule: ShellModule | undefined;
  let loaderFile: string | undefined;
  let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

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
    // receives the merged context. This removes one serial await from
    // every request (typically the shell module load after the loader).
    const middlewarePromise = runMiddlewareChain({
      context: routeArgs.context,
      middlewareFiles: match.route.middlewareFiles,
      params: match.params,
      registry,
      request: options.request,
      route: match.route,
      url,
    });

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

    // --- Middleware chain ---
    const middlewareResult = await middlewarePromise;
    if (middlewareResult.response) {
      return normalizePageResponse(middlewareResult.response, { isRouteStateRequest });
    }

    routeArgs = {
      ...routeArgs,
      context: middlewareResult.context,
    };

    currentPhase = "render";
    routeModule = await routeModulePromise;
    if (!routeModule) {
      throw new Error("Route module not found");
    }

    currentPhase = "loader";
    const { loader, loaderFile: resolvedLoaderFile } = await dataFunctionsPromise;
    loaderFile = resolvedLoaderFile;

    const loaderResult = loader ? await loader(routeArgs) : undefined;

    // Allow loaders to return a Response directly (e.g. for redirects)
    if (loaderResult instanceof Response) {
      return normalizePageResponse(loaderResult, { isRouteStateRequest });
    }

    const data = loaderResult;

    if (isRouteStateRequest) {
      return withRouteResponseHeaders(Response.json({ data }), { isRouteStateRequest: true });
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

      if (shellModule?.Shell || shellModule?.Loading) {
        const Shell = shellModule?.Shell as FunctionComponent | undefined;
        const Loading = shellModule?.Loading as FunctionComponent | undefined;
        const loadingTree =
          Shell != null
            ? h(Shell, null, Loading ? h(Loading, null) : null)
            : Loading
              ? h(Loading, null)
              : null;

        if (loadingTree) {
          const renderFn = await getRenderToStringAsync();
          body = await renderFn(loadingTree);
        }
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
    const Component = (routeModule.Component ?? DefaultComponent) as FunctionComponent | undefined;
    if (!Component) {
      throw new Error("Route has no Component or default export");
    }

    const Shell = shellModule?.Shell as FunctionComponent<Record<string, unknown>> | undefined;
    const Comp = Component as FunctionComponent<Record<string, unknown>>;
    const componentProps = { data, params: match.params };

    const componentTree = Shell ? h(Shell, null, h(Comp, componentProps)) : h(Comp, componentProps);

    const tree = h(
      PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
      {
        data,
        params: match.params,
        routeId: match.route.id ?? "",
        url: requestPath,
      },
      componentTree,
    );
    const renderToString = await getRenderToStringAsync();
    const ssrContent = await renderToString(tree);

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
      shellFile: match.route.shellFile,
      shellModule,
      requestPath,
    });
  }
}

function getRequestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

// Public runtime surface — re-exported so `./runtime.ts` remains the
// single import entry for the framework's runtime API.
export { applyDefaultSecurityHeaders } from "./runtime-headers.ts";
export {
  deserializeRouteError,
  type PrachtRuntimeDiagnosticPhase,
  type PrachtRuntimeDiagnostics,
  type SerializedRouteError,
} from "./runtime-errors.ts";
export {
  Form,
  PrachtRuntimeProvider,
  readHydrationState,
  startApp,
  useLocation,
  useParams,
  useRevalidate,
  useRouteData,
  type FormProps,
  type Location,
  type PrachtHydrationState,
  type StartAppOptions,
} from "./runtime-hooks.ts";
export { fetchPrachtRouteState, type RouteStateResult } from "./runtime-client-fetch.ts";
