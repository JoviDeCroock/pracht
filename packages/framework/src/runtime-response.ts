import { h, options as preactOptions } from "preact";
import type { ComponentChildren, FunctionComponent, VNode } from "preact";

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
  appendVaryHeader,
  withDefaultSecurityHeaders,
  withRouteResponseHeaders,
} from "./runtime-headers.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
  resolvePageCssAssets,
  resolvePageJsUrls,
  resolveRegistryModule,
} from "./runtime-manifest.ts";
import { mergeDocumentHeaders, mergeErrorHeadMetadata } from "./runtime-middleware.ts";
import { PrachtRuntimeProvider } from "./runtime-hooks.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import type {
  BaseRouteArgs,
  HrefRouteDefinition,
  LoaderCache,
  ResolvedApiRoute,
  RouteModule,
  ShellModule,
} from "./types.ts";
import { collectFontHeadFragments, type FontHeadFragments } from "./font.ts";

let _renderToStringAsync: typeof import("preact-render-to-string").renderToStringAsync | undefined;
const frameworkFontHeadResponses = new WeakSet<Response>();

export function markFrameworkFontHeadResponse(response: Response): Response {
  frameworkFontHeadResponses.add(response);
  return response;
}

export function isFrameworkFontHeadResponse(response: Response): boolean {
  return frameworkFontHeadResponses.has(response);
}

export async function getRenderToStringAsync() {
  // preact-render-to-string leaves class error boundaries disabled by default.
  // Keep this enabled process-wide: Pracht can render many SSG routes in
  // parallel, so temporarily toggling the global option would be racy.
  (
    preactOptions as typeof preactOptions & {
      errorBoundaries?: boolean;
    }
  ).errorBoundaries = true;
  if (_renderToStringAsync) return _renderToStringAsync;
  const mod = await import("preact-render-to-string");
  _renderToStringAsync = mod.renderToStringAsync;
  return _renderToStringAsync;
}

interface HandleRequestOptionsLike {
  debugErrors?: boolean;
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  cssContentManifest?: Record<string, string>;
  jsManifest?: Record<string, string[]>;
  registry?: import("./types.ts").ModuleRegistry;
}

export function jsonErrorResponse(
  routeError: SerializedRouteError,
  options: { fontHead?: FontHeadFragments; isRouteStateRequest: boolean },
): Response {
  const headers = applySecurityAndRouteHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
    options.isRouteStateRequest ? { isRouteStateRequest: true } : undefined,
  );
  return new Response(
    JSON.stringify({
      error: routeError,
      ...(options.fontHead ? { fontHead: options.fontHead } : {}),
    }),
    {
      status: routeError.status,
      headers,
    },
  );
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
  options: { isRouteStateRequest: boolean; loaderCache?: LoaderCache; markdown?: boolean },
): Response {
  const hasFrameworkFontHead = isFrameworkFontHeadResponse(response);
  if (options.isRouteStateRequest && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      return jsonRedirectResponse(location, {
        headers: response.headers,
        isRouteStateRequest: true,
      });
    }
  }

  const normalized = withRouteResponseHeaders(response, {
    isRouteStateRequest: options.isRouteStateRequest,
    loaderCache: response.ok ? options.loaderCache : undefined,
  });
  if (options.markdown === true && !options.isRouteStateRequest) {
    appendVaryHeader(normalized.headers, "Accept");
  }
  return hasFrameworkFontHead ? markFrameworkFontHeadResponse(normalized) : normalized;
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
  routes?: readonly HrefRouteDefinition[];
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

  const shellModule =
    options.shellModule ??
    (options.shellFile
      ? await resolveRegistryModule<ShellModule>(
          options.options.registry?.shellModules,
          options.shellFile,
        ).catch(() => undefined)
      : undefined);

  if (options.isRouteStateRequest) {
    let fontHead = collectFontHeadFragments([]);
    try {
      const head = await mergeErrorHeadMetadata(
        shellModule,
        options.routeModule,
        options.routeArgs,
      );
      fontHead = collectFontHeadFragments(head.fonts ?? []);
    } catch {
      // Error rendering must preserve the original route failure even if
      // optional head enrichment cannot be evaluated.
    }
    return jsonErrorResponse(routeErrorWithDiagnostics, {
      fontHead,
      isRouteStateRequest: true,
    });
  }

  const ErrorBoundary = options.routeModule?.ErrorBoundary ?? shellModule?.ErrorBoundary;

  if (!ErrorBoundary) {
    const message =
      routeErrorWithDiagnostics.status >= 500 && !exposeDetails
        ? "Internal Server Error"
        : routeErrorWithDiagnostics.message;
    const diagnostics =
      exposeDetails && routeErrorWithDiagnostics.diagnostics
        ? `\n\n${JSON.stringify(routeErrorWithDiagnostics.diagnostics, null, 2)}`
        : "";
    return withDefaultSecurityHeaders(
      new Response(`${message}${diagnostics}`, {
        status: routeErrorWithDiagnostics.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }
  const head = await mergeErrorHeadMetadata(shellModule, options.routeModule, options.routeArgs);
  const documentHeaders = await mergeDocumentHeaders(
    shellModule,
    undefined,
    options.routeArgs,
    undefined,
  );
  const cssAssets = resolvePageCssAssets(
    options.options.cssManifest,
    options.options.cssContentManifest,
    options.shellFile,
    options.routeArgs.route.file,
  );
  const modulePreloadUrls = mergeEntryPreloadUrls(
    options.options.jsManifest,
    CLIENT_ENTRY_MANIFEST_KEY,
    resolvePageJsUrls(options.options.jsManifest, options.shellFile, options.routeArgs.route.file),
  );
  const renderToString = await getRenderToStringAsync();

  const Boundary = ErrorBoundary as unknown as FunctionComponent<{
    error: Error;
  }>;
  const Shell = shellModule?.Shell as unknown as
    | FunctionComponent<{ children?: ComponentChildren }>
    | undefined;
  const errorValue = deserializeRouteError(routeErrorWithDiagnostics);
  const componentTree = Shell
    ? h(Shell, null, h(Boundary, { error: errorValue }))
    : h(Boundary, { error: errorValue });
  let tree: VNode<any> = h(
    PrachtRuntimeProvider as unknown as FunctionComponent<{
      data: null;
      routeId: string;
      routes?: readonly HrefRouteDefinition[];
      url: string;
      children?: ComponentChildren;
    }>,
    { data: null, routeId: options.routeId, routes: options.routes, url: options.requestPath },
    componentTree,
  );
  const hydration = options.routeArgs.route.hydration ?? "full";
  let islandCapture: IslandCapture | null = null;
  if (hydration === "islands") {
    islandCapture = { islands: [] };
    tree = h(
      IslandCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: islandCapture },
      tree,
    );
  }
  const body = await renderToString(tree);

  if (hydration !== "full") {
    const islandFiles = [
      ...new Set((islandCapture?.islands ?? []).map((usage) => usage.descriptor.file)),
    ];
    let islandsEntryUrl: string | undefined;
    const needsIslandsBootstrap =
      hydration === "islands" &&
      (islandFiles.length > 0 || options.options.islandsBootstrapRequired === true);
    if (needsIslandsBootstrap) {
      islandsEntryUrl = options.options.islandsEntryUrl ?? getIslandsClientEntryUrl();
      if (!islandsEntryUrl) {
        throw new Error(
          `Route "${options.routeArgs.route.path}" uses hydration: "islands" and requires the ` +
            `islands bootstrap${islandFiles.length > 0 ? ` for ${islandFiles.length} island(s) in its error boundary` : " for a page-level runtime projection"}, but no bootstrap URL is registered. ` +
            (islandFiles.length > 0
              ? "This usually means the @pracht/vite-plugin islands entry was not built — check that your islands live in the configured islands directory."
              : "This usually means generated page-runtime metadata was not forwarded by the deployment adapter."),
        );
      }
    }

    const preloadFiles = new Set(
      (islandCapture?.islands ?? [])
        .filter((usage) => usage.strategy === "load")
        .map((usage) => usage.descriptor.file),
    );
    const islandPreloadUrls = new Set<string>();
    if (options.options.jsManifest) {
      for (const file of preloadFiles) {
        for (const url of resolveManifestEntries(options.options.jsManifest, file) ?? []) {
          islandPreloadUrls.add(url);
        }
      }
    }

    return htmlResponse(
      buildHtmlDocument({
        head,
        body,
        clientEntryUrl: islandsEntryUrl,
        cssAssets,
        modulePreloadUrls: islandsEntryUrl
          ? mergeEntryPreloadUrls(options.options.jsManifest, ISLANDS_ENTRY_MANIFEST_KEY, [
              ...islandPreloadUrls,
            ])
          : [...islandPreloadUrls],
      }),
      routeErrorWithDiagnostics.status,
      documentHeaders,
    );
  }

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
      cssAssets,
      modulePreloadUrls,
    }),
    routeErrorWithDiagnostics.status,
    documentHeaders,
  );
}
