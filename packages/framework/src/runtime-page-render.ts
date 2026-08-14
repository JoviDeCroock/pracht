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
import { IslandCaptureContext, type IslandCapture } from "./islands-server.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { appendVaryHeader } from "./runtime-header-values.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolvePageCssUrls,
  resolvePageJsUrls,
} from "./runtime-manifest.ts";
import { markdownResponse, prefersMarkdown } from "./runtime-negotiation.ts";
import { renderSpaPageRepresentation } from "./runtime-page-render-spa.ts";
import { renderStaticPageRepresentation } from "./runtime-page-render-static.ts";
import type { RenderPageRepresentationOptions } from "./runtime-page-render-types.ts";
import { getRenderToStringAsync } from "./runtime-rendering.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import {
  createScriptCapture,
  ScriptCaptureContext,
  withCapturedScripts,
} from "./script-capture.ts";

export type { RenderPageRepresentationOptions } from "./runtime-page-render-types.ts";

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
    return renderSpaPageRepresentation(options, cssUrls, modulePreloadUrls);
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
    return renderStaticPageRepresentation(
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
