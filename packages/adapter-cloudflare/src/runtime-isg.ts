/** Worker-managed Cache API ISG serving and webhook regeneration. */

import {
  applyDefaultSecurityHeaders,
  classifyRevalidationSkip,
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  isCacheableISGResponse,
  jsonResponse,
  matchAppRoute,
  type MarkdownManifest,
  type PrachtApp,
  PRACHT_REVALIDATE_TOKEN_ENV,
  prefersMarkdown,
  readRevalidationRequest,
  RevalidationReport,
} from "@pracht/core/server";
import { purgeCache } from "./cache.ts";
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

export async function handleCloudflareRevalidationEndpoint(
  request: Request,
  env: Record<string, unknown>,
  app: PrachtApp,
  isgManifest: ISGManifest,
  renderISGPage: RenderISGPage,
  edgeCacheEnabled: boolean,
): Promise<Response> {
  const parsed = await readRevalidationRequest(
    request,
    typeof env[PRACHT_REVALIDATE_TOKEN_ENV] === "string"
      ? (env[PRACHT_REVALIDATE_TOKEN_ENV] as string)
      : undefined,
  );
  if (!parsed.ok) return parsed.response;

  const cache = getDefaultCache();
  if (!cache) {
    return jsonResponse(
      {
        error: "Cloudflare Cache API is unavailable.",
        failed: [],
        revalidated: [],
        skipped: parsed.paths,
      },
      503,
    );
  }

  const report = new RevalidationReport();

  for (const pathname of parsed.paths) {
    try {
      const entry = isgManifest[pathname];
      const skip = classifyRevalidationSkip(
        entry && { render: "isg", revalidate: entry.revalidate },
        entry !== undefined,
        matchAppRoute(app, pathname)?.route ?? null,
      );
      if (skip) {
        report.skipped(pathname, skip);
        continue;
      }

      const cacheKey = createISGCacheKey(request, pathname);
      // A failed regeneration keeps the existing cached copy and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (await regenerateCloudflareISGPage(cache, cacheKey, pathname, request, renderISGPage)) {
        report.revalidated(pathname);
        // Routes with both a time and a webhook policy are served through
        // Workers Caching when the `cache` option is on — the edge copy must
        // be purged too, or it keeps serving the old page until its TTL. A
        // purge failure keeps the path in `revalidated` (the worker-managed
        // copy is fresh); the edge falls back to its time window.
        if (edgeCacheEnabled && getTimeRevalidateSeconds(entry.revalidate) !== null) {
          try {
            await purgeCache({ pathPrefixes: [pathname] });
          } catch (err) {
            console.error(`ISG edge cache purge failed for ${pathname}:`, err);
          }
        }
      } else {
        report.failed(pathname, "regeneration_failed");
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      report.failed(pathname, "regeneration_error");
    }
  }

  return jsonResponse(report.toJSON());
}

/**
 * Render an ISG page and overwrite its Cache API entry. Returns `true` when
 * a fresh copy was stored. Render errors and `cache.put()` failures are
 * logged and swallowed — the previously cached (stale) copy stays live.
 */
async function regenerateCloudflareISGPage(
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

function createISGCacheKey(request: Request, pathname: string): Request {
  const url = new URL(pathname, request.url);
  url.search = "";
  url.hash = "";
  return new Request(url, {
    method: "GET",
    headers: { accept: "text/html" },
  });
}

function getDefaultCache(): Cache | null {
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
