/**
 * Page representation rendering.
 *
 * By the time this module runs, middleware, loader data, route/shell modules,
 * head metadata, and document headers are settled. It chooses the negotiated
 * representation and renders SPA, fully hydrated, islands, or zero-JavaScript
 * HTML without depending on request dispatch or module loading.
 */

import { h } from "preact";
import type { FunctionComponent } from "preact";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import { buildRouteStateUrl } from "./runtime-client-fetch.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { appendVaryHeader } from "./runtime-headers.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
  resolvePageCssUrls,
  resolvePageJsUrls,
} from "./runtime-manifest.ts";
import { markdownResponse, prefersMarkdown } from "./runtime-negotiation.ts";
import { getRenderToStringAsync } from "./runtime-response.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import { createScriptCapture, ScriptCaptureContext, withCapturedScripts } from "./script.ts";
import type {
  HeadMetadata,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
} from "./types.ts";

export interface RenderPageRepresentationOptions {
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  data: unknown;
  documentHeaders: Headers;
  hasLoader: boolean;
  head: HeadMetadata;
  islandsBootstrapRequired?: boolean;
  islandsEntryUrl?: string;
  jsManifest?: Record<string, string[]>;
  match: RouteMatch;
  request: Request;
  requestPath: string;
  resolvedApp: ResolvedPrachtApp;
  routeModule: RouteModule;
  shellModule: ShellModule | undefined;
  status: number;
}

export async function renderPageRepresentation(
  options: RenderPageRepresentationOptions,
): Promise<Response> {
  const { match, routeModule, shellModule } = options;

  // Both representations carry the same Vary header so an HTML cache entry
  // can never satisfy a later Markdown request, or vice versa.
  const markdownRepresentation =
    typeof routeModule.markdown === "string" ? routeModule.markdown : undefined;
  if (markdownRepresentation !== undefined) {
    appendVaryHeader(options.documentHeaders, "Accept");
  }
  if (
    markdownRepresentation !== undefined &&
    prefersMarkdown(options.request.headers.get("accept"))
  ) {
    return markdownResponse(markdownRepresentation, options.documentHeaders, options.status);
  }

  const cssUrls = resolvePageCssUrls(options.cssManifest, match.route.shellFile, match.route.file);
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
    // <Script strategy="beforeHydration"> inside the shell still lands in
    // the document head.
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
            routes: options.resolvedApp.routes,
            url: options.requestPath,
          },
          loadingTree,
        ),
      );
      const render = await getRenderToStringAsync();
      body = await render(tree);
    }

    return htmlResponse(
      buildHtmlDocument({
        head: withCapturedScripts(options.head, spaScriptCapture),
        body,
        hydrationState: {
          url: options.requestPath,
          routeId: match.route.id ?? "",
          data: null,
          error: null,
          pending: true,
        },
        clientEntryUrl: options.clientEntryUrl,
        cssUrls,
        modulePreloadUrls,
        routeStatePreloadUrl: options.hasLoader
          ? buildRouteStateUrl(options.requestPath)
          : undefined,
        speculationRules: getAppSpeculationRules(options.resolvedApp),
      }),
      options.status,
      options.documentHeaders,
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
  const componentProps = { data: options.data, params: match.params };
  const componentTree = Shell ? h(Shell, null, h(Comp, componentProps)) : h(Comp, componentProps);

  let tree = h(
    PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
    {
      data: options.data,
      params: match.params,
      routeId: match.route.id ?? "",
      routes: options.resolvedApp.routes,
      url: options.requestPath,
    },
    componentTree,
  );

  const hydration = match.route.hydration ?? "full";

  // Captured before-hydration scripts are request-local, so parallel renders
  // cannot attribute one page's scripts to another page.
  const scriptCapture = createScriptCapture(hydration);
  tree = h(
    ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
    { value: scriptCapture },
    tree,
  );

  let islandCapture: IslandCapture | null = null;
  if (hydration === "islands") {
    // Capture state travels through context, so concurrent async renders never
    // attribute islands to the wrong page.
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
    return renderStaticRepresentation(
      options,
      ssrContent,
      islandCapture,
      cssUrls,
      withCapturedScripts(options.head, scriptCapture),
    );
  }

  return htmlResponse(
    buildHtmlDocument({
      head: withCapturedScripts(options.head, scriptCapture),
      body: ssrContent,
      hydrationState: {
        url: options.requestPath,
        routeId: match.route.id ?? "",
        data: options.data,
        error: null,
      },
      clientEntryUrl: options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
      speculationRules: getAppSpeculationRules(options.resolvedApp),
    }),
    options.status,
    options.documentHeaders,
  );
}

function renderStaticRepresentation(
  options: RenderPageRepresentationOptions,
  ssrContent: string,
  islandCapture: IslandCapture | null,
  cssUrls: string[],
  head: HeadMetadata,
): Response {
  const islandFiles = [
    ...new Set((islandCapture?.islands ?? []).map((usage) => usage.descriptor.file)),
  ];
  let islandsEntryUrl: string | undefined;
  const needsIslandsBootstrap =
    options.match.route.hydration === "islands" &&
    (islandFiles.length > 0 || options.islandsBootstrapRequired === true);
  if (needsIslandsBootstrap) {
    islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
    if (!islandsEntryUrl) {
      throw new Error(
        `Route "${options.match.route.path}" uses hydration: "islands" and requires the ` +
          `islands bootstrap${islandFiles.length > 0 ? ` for ${islandFiles.length} rendered island(s)` : " for a page-level runtime projection"}, but no bootstrap URL is registered. ` +
          (islandFiles.length > 0
            ? "This usually means the @pracht/vite-plugin islands entry was not built — check that your islands live in the configured islands directory."
            : "This usually means generated page-runtime metadata was not forwarded by the deployment adapter."),
      );
    }
  }

  // Only preload islands that hydrate immediately. Preloading visible/idle
  // islands would defeat their deferred-network strategy.
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

  return htmlResponse(
    buildHtmlDocument({
      head,
      body: ssrContent,
      clientEntryUrl: islandsEntryUrl,
      cssUrls,
      modulePreloadUrls: islandsEntryUrl
        ? mergeEntryPreloadUrls(options.jsManifest, ISLANDS_ENTRY_MANIFEST_KEY, [
            ...islandPreloadUrls,
          ])
        : [...islandPreloadUrls],
      speculationRules: getAppSpeculationRules(options.resolvedApp),
    }),
    options.status,
    options.documentHeaders,
  );
}
