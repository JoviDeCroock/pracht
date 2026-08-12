import {
  handlePrachtRequest,
  preventHeuristicCaching,
  PRACHT_REVALIDATE_ENDPOINT,
  type HandlePrachtRequestOptions,
} from "@pracht/core/server";

import { isVercelISGRegenerationContext } from "./node-listener.js";
import { handleVercelRevalidationEndpoint } from "./revalidation.js";
import type { VercelAdapterOptions, VercelExecutionContext } from "./types.js";

export function createVercelEdgeHandler<
  TVercelContext extends VercelExecutionContext = VercelExecutionContext,
  TContext = TVercelContext,
>(options: VercelAdapterOptions<TVercelContext, TContext>) {
  return async (request: Request, context: TVercelContext): Promise<Response> => {
    if (new URL(request.url).pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleVercelRevalidationEndpoint(request, options.app);
    }

    const prachtContext = options.createContext
      ? await options.createContext({ request, context })
      : (context as unknown as TContext);

    const response = await handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request,
      context: prachtContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    // Vercel's CDN can apply heuristic freshness to a 200 with no explicit
    // policy while Cookie is absent from its cache key. The Node ISG bridge is
    // the exception: its `.prerender-config.json` owns caching, and stamping
    // `private, no-cache` there would poison the shared prerender output.
    if (isVercelISGRegenerationContext(context)) return response;
    return preventHeuristicCaching(request, response);
  };
}
