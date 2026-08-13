import { h } from "preact";
import type { ComponentChildren, FunctionComponent, VNode } from "preact";

import {
  buildRuntimeDiagnostics,
  deserializeRouteError,
  normalizeRouteError,
  shouldExposeServerErrors,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
  resolvePageCssUrls,
  resolvePageJsUrls,
  resolveRegistryModule,
} from "./runtime-manifest.ts";
import { mergeDocumentHeaders } from "./runtime-document-metadata.ts";
import { PrachtRuntimeProvider } from "./runtime-hooks.ts";
import { getRenderToStringAsync } from "./runtime-rendering.ts";
import type { RuntimeResponseOptions } from "./runtime-response-types.ts";
import { jsonErrorResponse } from "./runtime-route-state-response.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import type { BaseRouteArgs, HrefRouteDefinition, RouteModule, ShellModule } from "./types.ts";

export async function renderRouteErrorResponse<TContext>(options: {
  error: unknown;
  isRouteStateRequest: boolean;
  loaderFile: string | undefined;
  options: RuntimeResponseOptions;
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
        cssUrls,
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
      cssUrls,
      modulePreloadUrls,
    }),
    routeErrorWithDiagnostics.status,
    documentHeaders,
  );
}
