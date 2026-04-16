import { h } from "preact";
import type { ComponentChildren, FunctionComponent } from "preact";

import {
  buildRuntimeDiagnostics,
  deserializeRouteError,
  normalizeRouteError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
  type SerializedRouteError,
} from "./runtime-errors.ts";
import {
  applySecurityAndRouteHeaders,
  withDefaultSecurityHeaders,
  withRouteResponseHeaders,
} from "./runtime-headers.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import { resolvePageCssUrls, resolvePageJsUrls } from "./runtime-manifest.ts";
import { mergeDocumentHeaders } from "./runtime-middleware.ts";
import { PrachtRuntimeProvider } from "./runtime-hooks.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type { BaseRouteArgs, ResolvedApiRoute, RouteModule, ShellModule } from "./types.ts";

let _renderToStringAsync: typeof import("preact-render-to-string").renderToStringAsync | undefined;
export async function getRenderToStringAsync() {
  if (_renderToStringAsync) return _renderToStringAsync;
  const mod = await import("preact-render-to-string");
  _renderToStringAsync = mod.renderToStringAsync;
  return _renderToStringAsync;
}

interface HandleRequestOptionsLike {
  debugErrors?: boolean;
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  registry?: import("./types.ts").ModuleRegistry;
}

export function jsonErrorResponse(
  routeError: SerializedRouteError,
  options: { isRouteStateRequest: boolean },
): Response {
  const headers = applySecurityAndRouteHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
    options.isRouteStateRequest ? { isRouteStateRequest: true } : undefined,
  );
  return new Response(JSON.stringify({ error: routeError }), {
    status: routeError.status,
    headers,
  });
}

export function jsonRedirectResponse(
  location: string,
  options: { headers?: HeadersInit; isRouteStateRequest: boolean },
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  const response = new Response(JSON.stringify({ redirect: location }), {
    status: 200,
    headers,
  });
  return withRouteResponseHeaders(response, { isRouteStateRequest: options.isRouteStateRequest });
}

export function normalizePageResponse(
  response: Response,
  options: { isRouteStateRequest: boolean },
): Response {
  if (options.isRouteStateRequest && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      return jsonRedirectResponse(location, {
        headers: response.headers,
        isRouteStateRequest: true,
      });
    }
  }

  return withRouteResponseHeaders(response, options);
}

export function renderApiErrorResponse<TContext>(options: {
  error: unknown;
  middlewareFiles: string[];
  options: HandleRequestOptionsLike & { context?: TContext };
  phase: PrachtRuntimeDiagnosticPhase;
  route: ResolvedApiRoute;
}): Response {
  const exposeDetails = shouldExposeServerErrors(options.options);
  const routeError = normalizeRouteError(options.error, {
    exposeDetails,
  });
  const routeErrorWithDiagnostics = exposeDetails
    ? {
        ...routeError,
        diagnostics: buildRuntimeDiagnostics({
          middlewareFiles: options.middlewareFiles,
          phase: options.phase,
          route: options.route,
          status: routeError.status,
        }),
      }
    : routeError;

  if (exposeDetails) {
    return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: false });
  }

  const message =
    routeErrorWithDiagnostics.status >= 500
      ? "Internal Server Error"
      : routeErrorWithDiagnostics.message;
  return withDefaultSecurityHeaders(
    new Response(message, {
      status: routeErrorWithDiagnostics.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}

export async function renderRouteErrorResponse<TContext>(options: {
  error: unknown;
  isRouteStateRequest: boolean;
  loaderFile: string | undefined;
  options: HandleRequestOptionsLike;
  phase: PrachtRuntimeDiagnosticPhase;
  routeArgs: BaseRouteArgs<TContext>;
  routeId: string;
  routeModule: RouteModule | undefined;
  shellFile: string | undefined;
  shellModule: ShellModule | undefined;
  requestPath: string;
}): Promise<Response> {
  const exposeDetails = shouldExposeServerErrors(options.options);
  const routeError = normalizeRouteError(options.error, {
    exposeDetails,
  });
  const routeErrorWithDiagnostics = exposeDetails
    ? {
        ...routeError,
        diagnostics: buildRuntimeDiagnostics({
          loaderFile: options.loaderFile,
          middlewareFiles: options.routeArgs.route.middlewareFiles,
          phase: options.phase,
          route: options.routeArgs.route,
          shellFile: options.shellFile,
          status: routeError.status,
        }),
      }
    : routeError;

  if (!options.routeModule?.ErrorBoundary) {
    if (options.isRouteStateRequest) {
      return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: true });
    }

    const message =
      routeErrorWithDiagnostics.status >= 500
        ? "Internal Server Error"
        : routeErrorWithDiagnostics.message;
    return withDefaultSecurityHeaders(
      new Response(message, {
        status: routeErrorWithDiagnostics.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (options.isRouteStateRequest) {
    return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: true });
  }

  const shellModule =
    options.shellModule ??
    (options.shellFile
      ? await resolveRegistryModule<ShellModule>(
          options.options.registry?.shellModules,
          options.shellFile,
        )
      : undefined);
  const head = shellModule?.head ? await shellModule.head(options.routeArgs) : {};
  const documentHeaders = await mergeDocumentHeaders(
    shellModule,
    undefined,
    options.routeArgs,
    undefined,
  );
  const cssUrls = resolvePageCssUrls(
    options.options.cssManifest,
    options.shellFile,
    options.routeArgs.route.file,
  );
  const modulePreloadUrls = resolvePageJsUrls(
    options.options.jsManifest,
    options.shellFile,
    options.routeArgs.route.file,
  );
  const renderToString = await getRenderToStringAsync();

  const ErrorBoundary = options.routeModule.ErrorBoundary as unknown as FunctionComponent<{
    error: Error;
  }>;
  const Shell = shellModule?.Shell as unknown as
    | FunctionComponent<{ children?: ComponentChildren }>
    | undefined;
  const errorValue = deserializeRouteError(routeErrorWithDiagnostics);
  const componentTree = Shell
    ? h(Shell, null, h(ErrorBoundary, { error: errorValue }))
    : h(ErrorBoundary, { error: errorValue });
  const tree = h(
    PrachtRuntimeProvider as unknown as FunctionComponent<{
      data: null;
      routeId: string;
      url: string;
      children?: ComponentChildren;
    }>,
    { data: null, routeId: options.routeId, url: options.requestPath },
    componentTree,
  );
  const body = await renderToString(tree);

  return htmlResponse(
    buildHtmlDocument({
      head,
      body,
      hydrationState: {
        url: options.requestPath,
        routeId: options.routeId,
        data: null,
        error: routeErrorWithDiagnostics,
      },
      clientEntryUrl: options.options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
    }),
    routeErrorWithDiagnostics.status,
    documentHeaders,
  );
}
