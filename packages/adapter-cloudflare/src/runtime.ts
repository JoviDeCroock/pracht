import {
  applyDefaultSecurityHeaders,
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  hasWebhookRevalidate,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  isCacheableISGResponse,
  jsonResponse,
  type ModuleRegistry,
  prefersMarkdown,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  prefersMarkdown,
  type ResolvedApiRoute,
  readRevalidationRequest,
  routeVariesOnAccept,
  setServerEnv,
  type PrachtApp,
} from "@pracht/core/server";
import {
  applyWorkersCacheHeaders,
  type CloudflareWorkersCacheOption,
  findCacheableIsgRoute,
  preventHeuristicCaching,
  purgeCache,
  resolveWorkersCacheOptions,
} from "./cache.ts";

type HeadersManifest = Record<string, Record<string, string>>;
type ISGManifest = Record<string, ISGManifestEntry>;

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

// Module-level so it survives across requests within an isolate even though
// the generated worker entry creates a fresh fetch handler per request.
// Collapses concurrent regenerations of the same path into one render.
const regenerationSingleFlight = createRevalidationSingleFlight();

export interface CloudflareFetcher {
  fetch(input: Request | URL | string): Promise<Response>;
}

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface CloudflareContextArgs<TEnv = Record<string, unknown>> {
  request: Request;
  env: TEnv;
  executionContext: CloudflareExecutionContext;
}

export interface CloudflareAdapterOptions<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  TContext = {
    env: TEnv;
    executionContext: CloudflareExecutionContext;
  },
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  assetsBinding?: string;
  headersManifest?: HeadersManifest;
  isgManifest?: ISGManifest;
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
  /**
   * Serve time-revalidated ISG routes through Cloudflare Workers Caching:
   * instead of the build-time static snapshot and the worker-managed Cache
   * API path, ISG pages are rendered on demand and cached at the edge for
   * their `revalidate` window (via `cloudflare-cdn-cache-control`), with
   * stale pages served instantly while the Worker re-renders in the
   * background. Webhook-only ISG routes keep the worker-managed path so
   * revalidation takes effect immediately. Requires
   * `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: CloudflareWorkersCacheOption;
}

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
        cssManifest: options.cssManifest,
        jsManifest: options.jsManifest,
      } satisfies HandlePrachtRequestOptions<TContext>);
    };

    if (new URL(request.url).pathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleCloudflareRevalidationEndpoint(
        request,
        env,
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
        renderISGPage,
      );
      if (isgResponse) return preventHeuristicCaching(request, isgResponse);

      const assetResponse = await maybeServeAsset(
        request,
        env,
        assetsBinding,
        options.headersManifest ?? {},
      );
      if (assetResponse) {
        return assetResponse;
      }
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

function createWorkersCacheRenderRequest(originalRequest: Request): Request {
  const request = createISGRegenerationRequest(
    new URL(originalRequest.url).pathname,
    originalRequest,
  );
  if (prefersMarkdown(originalRequest.headers.get("accept"))) {
    request.headers.set("accept", "text/markdown");
  }
  return request;
}

async function maybeServeAsset(
  request: Request,
  env: Record<string, unknown>,
  assetsBinding: string,
  headersManifest: HeadersManifest = {},
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  // The handler short-circuits upgrades before reaching here; this keeps the
  // guarantee local, so no future caller can forward a handshake to a Fetcher.
  if (request.headers.has("upgrade")) {
    return null;
  }

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return null;
  }

  if (wantsRouteMarkdown(request, headersManifest, url.pathname)) {
    return null;
  }

  const assets = env[assetsBinding];
  if (!isFetcher(assets)) {
    return null;
  }

  const response = await assets.fetch(request);
  if (response.status === 404) return null;

  const headers = new Headers(response.headers);
  headers.append("Vary", "x-pracht-route-state-request");
  applyDefaultSecurityHeaders(headers);
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, url.pathname);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function maybeServeISG<TEnv extends Record<string, unknown>>(
  request: Request,
  env: TEnv,
  executionContext: CloudflareExecutionContext,
  assetsBinding: string,
  isgManifest: ISGManifest,
  headersManifest: HeadersManifest,
  renderISGPage: (pathname: string, originalRequest: Request) => Promise<Response>,
): Promise<Response | null> {
  if (!isDocumentAssetRequest(request, headersManifest)) return null;

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

  const assetResponse = await maybeServeAsset(request, env, assetsBinding, headersManifest);
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

async function handleCloudflareRevalidationEndpoint(
  request: Request,
  env: Record<string, unknown>,
  isgManifest: ISGManifest,
  renderISGPage: (pathname: string, originalRequest: Request) => Promise<Response>,
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

  const revalidated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const pathname of parsed.paths) {
    try {
      const entry = isgManifest[pathname];
      if (!entry || !hasWebhookRevalidate(entry.revalidate)) {
        skipped.push(pathname);
        continue;
      }

      const cacheKey = createISGCacheKey(request, pathname);
      // A failed regeneration keeps the existing cached copy and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (await regenerateCloudflareISGPage(cache, cacheKey, pathname, request, renderISGPage)) {
        revalidated.push(pathname);
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
        failed.push(pathname);
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      failed.push(pathname);
    }
  }

  return jsonResponse({ failed, revalidated, skipped });
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
  renderISGPage: (pathname: string, originalRequest: Request) => Promise<Response>,
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

function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const routeHeaders = getManifestHeaders(headersManifest, pathname);
  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

function getManifestHeaders(
  headersManifest: HeadersManifest,
  pathname: string,
): Record<string, string> | undefined {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  return (
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex]
  );
}

/**
 * A request may only skip the assets binding / edge cache when it explicitly
 * prefers markdown over HTML *and* the route declares `Vary: Accept` (which the
 * build emits for routes exporting `markdown`). Without both, apps that ship no
 * markdown keep answering every request — agent or browser — from the
 * prerendered document.
 */
function wantsRouteMarkdown(
  request: Request,
  headersManifest: HeadersManifest,
  pathname: string,
): boolean {
  return (
    prefersMarkdown(request.headers.get("accept")) &&
    routeVariesOnAccept(getManifestHeaders(headersManifest, pathname))
  );
}

function isFetcher(value: unknown): value is CloudflareFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

function isDocumentAssetRequest(request: Request, headersManifest: HeadersManifest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return false;
  }

  return !wantsRouteMarkdown(request, headersManifest, url.pathname);
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

function isCloudflareISGStale(entry: ISGManifestEntry, response: Response): boolean {
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
