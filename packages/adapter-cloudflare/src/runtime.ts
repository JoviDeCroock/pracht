/** Cloudflare request orchestration across assets, ISG, and the Pracht runtime. */

import {
  createISGRegenerationRequest,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  PRACHT_REVALIDATE_ENDPOINT,
  preventHeuristicCaching,
  setServerEnv,
} from "@pracht/core/server";
import {
  applyWorkersCacheHeaders,
  findCacheableIsgRoute,
  resolveWorkersCacheOptions,
} from "./cache-policy.ts";
import { maybeServeAsset } from "./runtime-assets.ts";
import { createWorkersCacheRenderRequest, maybeServeISG } from "./runtime-isg-cache.ts";
import { handleCloudflareRevalidationEndpoint } from "./runtime-isg-revalidation.ts";
import type { CloudflareAdapterOptions, CloudflareExecutionContext } from "./runtime-types.ts";

export type {
  CloudflareAdapterOptions,
  CloudflareContextArgs,
  CloudflareExecutionContext,
  CloudflareFetcher,
} from "./runtime-types.ts";

export function createCloudflareFetchHandler<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  TContext = {
    env: TEnv;
    executionContext: CloudflareExecutionContext;
  },
>(options: CloudflareAdapterOptions<TEnv, TContext>) {
  const assetsBinding = options.assetsBinding ?? "ASSETS";
  const cacheOptions = resolveWorkersCacheOptions(options.cache);

  return async (
    request: Request,
    env: TEnv,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response> => {
    // Make `serverEnv` from @pracht/core/env/server resolve to this worker request's bindings.
    setServerEnv(env);

    const renderISGPage = async (pathname: string, originalRequest: Request): Promise<Response> => {
      const regenerationRequest = createISGRegenerationRequest(pathname, originalRequest);
      const context = options.createContext
        ? await options.createContext({ request: regenerationRequest, env, executionContext })
        : ({ env, executionContext } as TContext);

      return handlePrachtRequest({
        app: options.app,
        registry: options.registry,
        request: regenerationRequest,
        context,
        apiRoutes: options.apiRoutes,
        clientEntryUrl: options.clientEntryUrl,
        islandsEntryUrl: options.islandsEntryUrl,
        islandsBootstrapRequired: options.islandsBootstrapRequired,
        cssManifest: options.cssManifest,
        jsManifest: options.jsManifest,
      } satisfies HandlePrachtRequestOptions<TContext>);
    };

    if (new URL(request.url).pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleCloudflareRevalidationEndpoint(
        request,
        env,
        options.app,
        options.isgManifest ?? {},
        renderISGPage,
        Boolean(cacheOptions),
      );
    }

    // A WebSocket handshake has no static counterpart: it can only be
    // answered by an API route (typically by forwarding the request to a
    // Durable Object, which owns the socket's lifetime). Skipping the ISG and
    // asset lookups keeps the handshake off a code path that would forward an
    // `Upgrade` request to the assets binding — a wasted subrequest per
    // connection, against a Fetcher that can never satisfy it.
    const isUpgradeRequest = request.headers.has("upgrade");

    // ISG routes served through Workers Caching bypass both the prerendered
    // static snapshot and the worker-managed Cache API path — the framework
    // re-renders and the edge cache holds the response for the revalidate
    // window.
    const cacheRoute =
      cacheOptions && !isUpgradeRequest ? findCacheableIsgRoute(options.app, request) : null;

    if (!cacheRoute && !isUpgradeRequest) {
      const isgResponse = await maybeServeISG(
        request,
        env,
        executionContext,
        assetsBinding,
        options.isgManifest ?? {},
        options.headersManifest ?? {},
        options.markdownManifest,
        renderISGPage,
      );
      if (isgResponse) return preventHeuristicCaching(request, isgResponse);

      const assetResponse = await maybeServeAsset(
        request,
        env,
        assetsBinding,
        options.headersManifest ?? {},
        options.markdownManifest,
      );
      if (assetResponse) return assetResponse;
    }

    const renderRequest = cacheRoute ? createWorkersCacheRenderRequest(request) : request;
    const context = options.createContext
      ? await options.createContext({ request: renderRequest, env, executionContext })
      : ({ env, executionContext } as TContext);

    const response = await handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request: renderRequest,
      context,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    const finalResponse =
      cacheRoute && cacheOptions
        ? applyWorkersCacheHeaders(response, cacheRoute, cacheOptions)
        : response;

    // Workers Caching heuristically caches 200 responses that lack a
    // Cache-Control header (and Cookie is not part of the cache key) —
    // stamp everything pracht did not deliberately mark cacheable so SSR
    // pages and API responses can never be edge-cached by accident. This
    // guards even when the adapter `cache` option is off, because
    // `"cache": { "enabled": true }` in wrangler config is independent.
    return preventHeuristicCaching(request, finalResponse);
  };
}
