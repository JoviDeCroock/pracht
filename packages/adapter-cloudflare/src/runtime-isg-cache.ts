/** Worker-managed Cache API ISG serving and regeneration. */

import {
  applyDefaultSecurityHeaders,
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  isCacheableISGResponse,
  type MarkdownManifest,
  prefersMarkdown,
} from "@pracht/core/server";
import { applyHeadersManifest, isDocumentAssetRequest, maybeServeAsset } from "./runtime-assets.ts";
import type {
  CloudflareExecutionContext,
  HeadersManifest,
  ISGManifest,
  RenderISGPage,
} from "./runtime-types.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

// Module-level so it survives across requests within an isolate even though
// the generated worker entry creates a fresh fetch handler per request.
// Collapses concurrent regenerations of the same path into one render.
const regenerationSingleFlight = createRevalidationSingleFlight();

export function createWorkersCacheRenderRequest(originalRequest: Request): Request {
  const request = createISGRegenerationRequest(
    new URL(originalRequest.url).pathname,
    originalRequest,
  );
  if (prefersMarkdown(originalRequest.headers.get("accept"))) {
    request.headers.set("accept", "text/markdown");
  }
  return request;
}

export async function maybeServeISG<TEnv extends Record<string, unknown>>(
  request: Request,
  env: TEnv,
  executionContext: CloudflareExecutionContext,
  assetsBinding: string,
  isgManifest: ISGManifest,
  headersManifest: HeadersManifest,
  markdownManifest: MarkdownManifest | undefined,
  renderISGPage: RenderISGPage,
): Promise<Response | null> {
  if (!isDocumentAssetRequest(request, markdownManifest)) return null;

  const url = new URL(request.url);
  const entry = isgManifest[url.pathname];
  if (!entry) return null;

  const cache = getDefaultCache();
  const cacheKey = createISGCacheKey(request, url.pathname);
  const cached = cache ? await cache.match(cacheKey) : undefined;
  if (cached) {
    const stale = isCloudflareISGStale(entry, cached);
    if (stale && cache) {
      executionContext.waitUntil(
        regenerateCloudflareISGPage(cache, cacheKey, url.pathname, request, renderISGPage),
      );
    }
    return prepareCloudflareISGResponse(cached, headersManifest, url.pathname, stale);
  }

  const assetResponse = await maybeServeAsset(
    request,
    env,
    assetsBinding,
    headersManifest,
    markdownManifest,
  );
  if (!assetResponse) return null;

  const stale = isCloudflareISGStale(entry, assetResponse);
  if (stale && cache) {
    executionContext.waitUntil(
      regenerateCloudflareISGPage(cache, cacheKey, url.pathname, request, renderISGPage),
    );
  }

  const headers = new Headers(assetResponse.headers);
  headers.set("x-pracht-isg", stale ? "stale" : "fresh");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

/**
 * Render an ISG page and overwrite its Cache API entry. Returns `true` when
 * a fresh copy was stored. Render errors and `cache.put()` failures are
 * logged and swallowed — the previously cached (stale) copy stays live.
 */
export async function regenerateCloudflareISGPage(
  cache: Cache,
  cacheKey: Request,
  pathname: string,
  request: Request,
  renderISGPage: RenderISGPage,
): Promise<boolean> {
  return regenerationSingleFlight(cacheKey.url, async () => {
    try {
      const response = await renderISGPage(pathname, request);
      if (response.status !== 200 || !isCacheableISGResponse(response)) return false;

      const headers = applyDefaultSecurityHeaders(new Headers(response.headers));
      headers.set("cache-control", "public, max-age=0, must-revalidate");
      headers.set("x-pracht-isg-generated-at", String(Date.now()));
      ensureRouteStateVary(headers);
      await cache.put(cacheKey, new Response(await response.text(), { status: 200, headers }));
      return true;
    } catch (err) {
      console.error(`ISG regeneration failed for ${pathname}:`, err);
      return false;
    }
  });
}

export function createISGCacheKey(request: Request, pathname: string): Request {
  const url = new URL(pathname, request.url);
  url.search = "";
  url.hash = "";
  return new Request(url, {
    method: "GET",
    headers: { accept: "text/html" },
  });
}

export function getDefaultCache(): Cache | null {
  const cacheStorage = (
    globalThis as typeof globalThis & { caches?: CacheStorage & { default?: Cache } }
  ).caches;
  return cacheStorage?.default ?? null;
}

function isCloudflareISGStale(entry: ISGManifest[string], response: Response): boolean {
  const seconds = getTimeRevalidateSeconds(entry.revalidate);
  if (seconds === null) return false;

  const generatedAt =
    Number(response.headers.get("x-pracht-isg-generated-at")) ||
    entry.generatedAt ||
    Date.parse(response.headers.get("last-modified") ?? "");
  if (!Number.isFinite(generatedAt)) return false;

  return Date.now() - generatedAt > seconds * 1000;
}

function prepareCloudflareISGResponse(
  response: Response,
  headersManifest: HeadersManifest,
  pathname: string,
  stale: boolean,
): Response {
  const headers = applyDefaultSecurityHeaders(new Headers(response.headers));
  applyHeadersManifest(headers, headersManifest, pathname);
  headers.set("x-pracht-isg", stale ? "stale" : "fresh");
  // Downstream caches must keep HTML documents and route-state JSON apart,
  // matching the Vary the asset path (`maybeServeAsset`) already sets.
  ensureRouteStateVary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ensureRouteStateVary(headers: Headers): void {
  const vary = headers.get("vary") ?? "";
  const varied = vary
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  if (varied.includes(ROUTE_STATE_REQUEST_HEADER) || varied.includes("*")) return;
  headers.append("Vary", ROUTE_STATE_REQUEST_HEADER);
}
