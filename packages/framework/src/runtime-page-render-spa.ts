import { h, type FunctionComponent } from "preact";
import { buildRouteStateUrl } from "./runtime-client-fetch.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import type { RenderPageRepresentationOptions } from "./runtime-page-render-types.ts";
import { getRenderToStringAsync } from "./runtime-rendering.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import { createScriptCapture, ScriptCaptureContext, withCapturedScripts } from "./script.ts";

export async function renderSpaPageRepresentation(
  options: RenderPageRepresentationOptions,
  cssUrls: string[],
  modulePreloadUrls: string[],
): Promise<Response> {
  const { match, shellModule } = options;
  let body = "";
  const Shell = shellModule?.Shell as FunctionComponent | undefined;
  const Loading = shellModule?.Loading as FunctionComponent | undefined;
  const loadingTree =
    Shell != null
      ? h(Shell, null, Loading ? h(Loading, null) : null)
      : Loading
        ? h(Loading, null)
        : null;

  const scriptCapture = createScriptCapture("full");
  if (loadingTree) {
    const tree = h(
      ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: scriptCapture },
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
      head: withCapturedScripts(options.head, scriptCapture),
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
      routeStatePreloadUrl: options.hasLoader ? buildRouteStateUrl(options.requestPath) : undefined,
      speculationRules: getAppSpeculationRules(options.resolvedApp),
    }),
    options.status,
    options.documentHeaders,
  );
}
