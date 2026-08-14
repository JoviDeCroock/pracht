import {
  applyDefaultSecurityHeaders,
  createISGRegenerationRequest,
  handlePrachtRequest,
  matchAppRoute,
  prefersMarkdown,
  PRACHT_REVALIDATE_ENDPOINT,
  routeSupportsMarkdown,
  type HandlePrachtRequestOptions,
} from "@pracht/core/server";

import {
  applyNetlifyDynamicCacheHeaders,
  applyNetlifyISGCacheHeaders,
  resolveCacheOptions,
} from "./runtime-cache.ts";
import { createNetlifyISGContext } from "./runtime-context.ts";
import { isRouteStateRequest, normalizePathname } from "./runtime-path.ts";
import { handleNetlifyRevalidation } from "./runtime-revalidation.ts";
import { resolveStaticFile, serveStaticFile } from "./runtime-static.ts";
import type { NetlifyExecutionContext, NetlifyHandlerOptions } from "./types.ts";

/**
 * Create a fetch-style Netlify Functions v2 handler.
 *
 * The generated function claims page URLs so negotiated Markdown and route
 * state requests reach Pracht, while ordinary SSG documents are read from the
 * bundled client output and cached in Netlify's durable cache.
 */
export function createNetlifyHandler<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
  TContext = TNetlifyContext,
>(options: NetlifyHandlerOptions<TNetlifyContext, TContext>) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const cache = resolveCacheOptions(options.cache);

  return async (request: Request, context: TNetlifyContext): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleNetlifyRevalidation(request, options, isgManifest);
    }

    const pathname = normalizePathname(url.pathname);
    const routeStateRequest = isRouteStateRequest(request, url);
    const markdownCapable =
      options.markdownManifest === undefined ||
      routeSupportsMarkdown(options.markdownManifest, pathname);
    const wantsMarkdown = prefersMarkdown(request.headers.get("accept")) && markdownCapable;
    const staticMethod = request.method === "GET" || request.method === "HEAD";

    // Netlify chooses its CDN cache key before the function runs. Rendering a
    // slashless Request would therefore still leave `/pricing` and
    // `/pricing/` in separate durable entries. Redirect document requests to
    // the manifest's canonical path so only the slashless URL renders.
    if (
      staticMethod &&
      !routeStateRequest &&
      !wantsMarkdown &&
      pathname !== url.pathname &&
      pathname in isgManifest
    ) {
      url.pathname = pathname;
      const headers = applyDefaultSecurityHeaders(
        new Headers({ location: `${url.pathname}${url.search}` }),
      );
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      return new Response(null, { headers, status: 308 });
    }

    if (
      options.staticDir &&
      staticMethod &&
      !routeStateRequest &&
      !wantsMarkdown &&
      !(pathname in isgManifest)
    ) {
      const file = await resolveStaticFile(options.staticDir, pathname);
      if (file) {
        return serveStaticFile(request, file, headersManifest, pathname, cache.staticMaxAge);
      }
    }

    const isgRoute =
      staticMethod && !routeStateRequest && !wantsMarkdown && pathname in isgManifest
        ? matchAppRoute(options.app, pathname)?.route
        : undefined;

    // A Netlify CDN response is shared by every visitor. Render ISG documents
    // from a request stripped of cookies, authorization, query, and body so the
    // visitor who triggers a cache miss cannot personalize the stored result.
    const renderRequest = isgRoute ? createISGRegenerationRequest(pathname, request) : request;
    const renderContext = isgRoute ? createNetlifyISGContext(context, renderRequest) : context;
    const prachtContext = options.createContext
      ? await options.createContext({ request: renderRequest, context: renderContext })
      : (renderContext as unknown as TContext);

    const response = await handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request: renderRequest,
      context: prachtContext,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    if (isgRoute) {
      return applyNetlifyISGCacheHeaders(response, isgRoute, pathname, cache);
    }

    const sharesStaticPageCachePolicy =
      options.staticDir !== undefined &&
      staticMethod &&
      wantsMarkdown &&
      !(pathname in isgManifest) &&
      (await resolveStaticFile(options.staticDir, pathname))?.document === true;

    return applyNetlifyDynamicCacheHeaders(
      request,
      response,
      routeStateRequest,
      sharesStaticPageCachePolicy,
    );
  };
}
