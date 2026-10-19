import { applyHeadersManifest, type SharedHeadersManifest } from "@pracht/core/server";
import {
  applyDefaultSecurityHeaders,
  captureISGSnapshot,
  createBaseRedirectResponse,
  createISGRegenerationRequest,
  createTrailingSlashRedirectResponse,
  createRevalidationSingleFlight,
  decodeISGSnapshot,
  encodeISGSnapshot,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  hasWebhookRevalidate,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  isgCacheKeyPath,
  isISGSnapshotRejection,
  isMcpResourceMetadataPath,
  jsonResponse,
  matchAppRoute,
  type ModuleRegistry,
  type MarkdownManifest,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  prefersMarkdown,
  type ResolvedApiRoute,
  classifyRevalidationSkip,
  readRevalidationRequest,
  RevalidationReport,
  restoreBasePathInRequest,
  routeSupportsMarkdown,
  serveISGSnapshot,
  setServerEnv,
  stripBase,
  type PrachtApp,
  preventHeuristicCaching,
  withBase,
} from "@pracht/core/server";
import {
  applyWorkersCacheHeaders,
  type CloudflareWorkersCacheOption,
  findCacheableIsgRoute,
  purgeCache,
  resolveWorkersCacheOptions,
} from "./cache.ts";

type HeadersManifest = Record<string, Record<string, string>> | SharedHeadersManifest;
type ISGManifest = Record<string, ISGManifestEntry>;

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

// The Workers Cache API derives an entry's lifetime from the `Cache-Control`
// it is stored with, so a regenerated ISG page is kept for a year and the
// snapshot's own render time decides when it is stale. Storing the browser
// policy instead (`max-age=0`) made every entry expire on write.
const ISG_CACHE_ENTRY_CACHE_CONTROL = "public, max-age=31536000";
// What browsers see on a cached ISG page whose render set no Cache-Control:
// always revalidate with the Worker, the same policy the build-time asset and
// the Node adapter send.
const ISG_BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate";

// Module-level so it survives across requests within an isolate even though
// the generated worker entry creates a fresh fetch handler per request.
// Collapses concurrent regenerations of the same path into one render.
const regenerationSingleFlight = createRevalidationSingleFlight();

// A Cache API that keeps nothing (a preview, or a host where its writes have
// no effect) would turn every miss on a webhook route into another render.
// One miss-triggered render per page per isolate per minute bounds that.
const MISS_REGENERATION_INTERVAL_MS = 60_000;
const MAX_TRACKED_MISS_REGENERATIONS = 1_000;
const missRegenerations = new Map<string, number>();

function claimMissRegeneration(key: string): boolean {
  const now = Date.now();
  const last = missRegenerations.get(key);
  if (last !== undefined && now - last < MISS_REGENERATION_INTERVAL_MS) return false;
  if (missRegenerations.size >= MAX_TRACKED_MISS_REGENERATIONS) missRegenerations.clear();
  missRegenerations.set(key, now);
  return true;
}

export interface CloudflareFetcher {
  fetch(input: Request | URL | string): Promise<Response>;
}

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

declare global {
  // The interface `wrangler types` fills from the wrangler config bindings.
  // Declared empty here so the default below resolves without generated types.
  namespace Cloudflare {
    interface Env {}
  }
}

/**
 * The bindings `wrangler types` generated into `Cloudflare.Env`, or a plain
 * record when the app has not generated them.
 */
export type CloudflareEnv = keyof Cloudflare.Env extends never
  ? Record<string, unknown>
  : Cloudflare.Env;

export interface CloudflareContextArgs<TEnv = CloudflareEnv> {
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
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  cssContentManifest?: Record<string, string>;
  jsManifest?: Record<string, string[]>;
  assetsBinding?: string;
  /** @internal Dev asset bindings already return public, base-prefixed redirects. */
  assetsBindingUsesPublicBase?: boolean;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit to preserve negotiation for legacy/custom entries. */
  markdownManifest?: MarkdownManifest;
  isgManifest?: ISGManifest;
  /**
   * The server entry's `buildId`. Regenerated ISG pages are cached under it,
   * so a new deploy never serves a page the previous one rendered.
   */
  buildId?: string;
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
  /**
   * Serve time-revalidated ISG routes through Cloudflare Workers Caching:
   * instead of the build-time static snapshot and the worker-managed Cache
   * API path, ISG pages are rendered on demand and cached at the edge for
   * their `revalidate` window (via `cloudflare-cdn-cache-control`), with
   * stale pages served instantly while the Worker re-renders in the
   * background. Webhook-only ISG routes keep the worker-managed path, where a
   * webhook refreshes the data center that receives it. Requires
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
    // The portable `waitUntil()` loaders, middleware, API routes, and
    // capabilities receive. Called through the execution context: workerd
    // rejects a detached `waitUntil` reference with "Illegal invocation".
    const waitUntil = (promise: Promise<unknown>): void => executionContext.waitUntil(promise);

    const baseRedirect = createBaseRedirectResponse(request);
    if (baseRedirect) return baseRedirect;

    const publicUrl = new URL(request.url);
    const routePathname = stripBase(publicUrl.pathname);
    const mcpAuth = options.app.agents?.mcp?.auth;
    const isMcpMetadataRequest =
      mcpAuth !== undefined && isMcpResourceMetadataPath(publicUrl.pathname, mcpAuth);

    const renderISGPage = async (pathname: string, originalRequest: Request): Promise<Response> => {
      const regenerationRequest = restoreBasePathInRequest(
        createISGRegenerationRequest(pathname, originalRequest),
      );
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
        cssContentManifest: options.cssContentManifest,
        jsManifest: options.jsManifest,
        waitUntil,
      } satisfies HandlePrachtRequestOptions<TContext>);
    };

    if (routePathname === PRACHT_REVALIDATE_ENDPOINT) {
      return handleCloudflareRevalidationEndpoint(
        request,
        env,
        options.app,
        options.isgManifest ?? {},
        options.buildId,
        renderISGPage,
        Boolean(cacheOptions),
      );
    }

    // Platform asset bindings and Pracht manifests are rooted at the deploy
    // artifact, not at Vite's public base. Keep a base-free transport request
    // for adapter dispatch while application code retains the public Request.
    // Construct it only after the POST revalidation path: cloning a request
    // with a body can otherwise disturb the stream before it reaches an API.
    const isStaticMethod = request.method === "GET" || request.method === "HEAD";
    const dispatchRequest =
      routePathname === null || !isStaticMethod || isMcpMetadataRequest
        ? null
        : withRequestPathname(request, routePathname);

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
      cacheOptions && !isUpgradeRequest && dispatchRequest
        ? findCacheableIsgRoute(options.app, dispatchRequest)
        : null;

    if (!cacheRoute && !isUpgradeRequest && dispatchRequest) {
      const isgResponse = await maybeServeISG(
        dispatchRequest,
        env,
        executionContext,
        assetsBinding,
        options.isgManifest ?? {},
        options.headersManifest ?? {},
        options.markdownManifest,
        options.assetsBindingUsesPublicBase,
        options.buildId,
        renderISGPage,
      );
      if (isgResponse) return preventHeuristicCaching(request, isgResponse);

      const assetResponse = await maybeServeAsset(
        dispatchRequest,
        env,
        assetsBinding,
        options.headersManifest ?? {},
        options.markdownManifest,
        options.assetsBindingUsesPublicBase,
      );
      if (assetResponse) {
        return assetResponse;
      }
    }

    // An edge-cached ISG page never reaches the assets binding that
    // canonicalizes the others, so `pracht({ trailingSlash })` applies here.
    const edgeCacheRedirect = cacheRoute ? createTrailingSlashRedirectResponse(request) : null;
    if (edgeCacheRedirect) return edgeCacheRedirect;
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
      cssContentManifest: options.cssContentManifest,
      jsManifest: options.jsManifest,
      waitUntil,
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

function withRequestPathname(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
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
  markdownManifest?: MarkdownManifest,
  assetsBindingUsesPublicBase = false,
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

  if (wantsRouteMarkdown(request, markdownManifest, url.pathname)) {
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
  applyHeadersManifest(headers, headersManifest, url.pathname);
  const location = headers.get("location");
  if (
    response.status >= 300 &&
    response.status < 400 &&
    location?.startsWith("/") &&
    !location.startsWith("//")
  ) {
    // The Cloudflare Vite asset binding receives the base-free dispatch URL,
    // but evaluates it beneath Vite's public base. At the app root it can
    // therefore redirect `/` to the browser's current `/app/` URL forever.
    // Let the Worker render that route instead. A real canonical redirect
    // such as `/app/guide` -> `/app/guide/` remains distinct and is preserved.
    if (assetsBindingUsesPublicBase && location === withBase(`${url.pathname}${url.search}`)) {
      return null;
    }
    headers.set("location", assetsBindingUsesPublicBase ? location : withBase(location));
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
  markdownManifest: MarkdownManifest | undefined,
  assetsBindingUsesPublicBase: boolean | undefined,
  buildId: string | undefined,
  renderISGPage: (pathname: string, originalRequest: Request) => Promise<Response>,
): Promise<Response | null> {
  if (!isDocumentAssetRequest(request, markdownManifest)) return null;

  const url = new URL(request.url);
  // Keyed by route path: `/about/` is the same page, and the same cache entry.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
  const entry = isgManifest[pathname];
  if (!entry) return null;

  const cache = getDefaultCache();
  const cacheKey = createISGCacheKey(request, pathname, entry, buildId);
  const cached = cache ? await cache.match(cacheKey) : undefined;
  if (cached) {
    // The assets binding's `html_handling` canonicalizes the spelling of every
    // page it serves; a cached page skips it, so `pracht({ trailingSlash })`
    // is applied here.
    const trailingSlashRedirect = createTrailingSlashRedirectResponse(
      restoreBasePathInRequest(request),
    );
    if (trailingSlashRedirect) return trailingSlashRedirect;
    const body = await cached.text();
    const snapshot = decodeISGSnapshot(body);
    const stale = snapshot
      ? isStaleSince(entry, snapshot.generatedAt)
      : isLegacyCloudflareISGStale(entry, cached);
    if (stale && cache) {
      executionContext.waitUntil(
        regenerateCloudflareISGPage(cache, cacheKey, pathname, request, buildId, renderISGPage),
      );
    }
    if (snapshot) {
      const served = serveISGSnapshot(snapshot, {
        stale,
        browserCacheControl: ISG_BROWSER_CACHE_CONTROL,
      });
      applyDefaultSecurityHeaders(served.headers);
      ensureRouteStateVary(served.headers);
      return served;
    }
    return prepareLegacyCloudflareISGResponse(cached, body, headersManifest, pathname, stale);
  }

  const assetResponse = await maybeServeAsset(
    request,
    env,
    assetsBinding,
    headersManifest,
    markdownManifest,
    assetsBindingUsesPublicBase,
  );
  if (!assetResponse) return null;

  // A route a webhook can refresh may have been refreshed in another data
  // center, or here before the Cache API evicted the copy: nothing local says
  // the build-time snapshot is still current, so it is served as stale and
  // this data center renders its own copy.
  const timeStale = isLegacyCloudflareISGStale(entry, assetResponse);
  const webhookMiss = !timeStale && hasWebhookRevalidate(entry.revalidate);
  const stale = timeStale || webhookMiss;
  if (cache && (timeStale || (webhookMiss && claimMissRegeneration(cacheKey.url)))) {
    executionContext.waitUntil(
      regenerateCloudflareISGPage(cache, cacheKey, pathname, request, buildId, renderISGPage),
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
  app: PrachtApp,
  isgManifest: ISGManifest,
  buildId: string | undefined,
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

  const report = new RevalidationReport("colo");

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

      const cacheKey = createISGCacheKey(request, pathname, entry, buildId);
      // A failed regeneration keeps the existing cached copy and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (
        await regenerateCloudflareISGPage(
          cache,
          cacheKey,
          pathname,
          request,
          buildId,
          renderISGPage,
        )
      ) {
        // Routes with both a time and a webhook policy are served through
        // Workers Caching when the `cache` option is on, never from the Cache
        // API copy: only the edge purge, which reaches every data center,
        // changes what visitors get. A rejected purge leaves them the old
        // page until its time window, so the path is reported as failed.
        if (edgeCacheEnabled && getTimeRevalidateSeconds(entry.revalidate) !== null) {
          if (await purgeEdgeCopy(pathname)) report.revalidated(pathname, "global");
          else report.failed(pathname, "edge_purge_failed");
        } else {
          // The Cache API copy is current only in the data center that ran
          // this request.
          report.revalidated(pathname, "colo");
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
 * Purge a page's Workers Caching entries. `cache.purge()` resolves
 * `{ success: false }` when Cloudflare rejects the purge (rate limits, for
 * one) and throws when it cannot run; both mean the edge copy is unchanged.
 */
async function purgeEdgeCopy(pathname: string): Promise<boolean> {
  try {
    const result = await purgeCache({ pathPrefixes: [withBase(pathname)] });
    if (
      typeof result === "object" &&
      result !== null &&
      (result as { success?: unknown }).success === false
    ) {
      console.error(`ISG edge cache purge was rejected for ${pathname}:`, result);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`ISG edge cache purge failed for ${pathname}:`, err);
    return false;
  }
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
  buildId: string | undefined,
  renderISGPage: (pathname: string, originalRequest: Request) => Promise<Response>,
): Promise<boolean> {
  return regenerationSingleFlight(cacheKey.url, async () => {
    try {
      const response = await renderISGPage(pathname, request);
      const snapshot = await captureISGSnapshot(response, { buildId, pathname });
      if (isISGSnapshotRejection(snapshot)) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      // The entry carries its storage TTL; the render's own Cache-Control
      // travels inside the snapshot.
      await cache.put(
        cacheKey,
        new Response(encodeISGSnapshot(snapshot), {
          status: 200,
          headers: {
            "cache-control": ISG_CACHE_ENTRY_CACHE_CONTROL,
            "content-type": "application/json",
          },
        }),
      );
      return true;
    } catch (err) {
      console.error(`ISG regeneration failed for ${pathname}:`, err);
      return false;
    }
  });
}

/**
 * A request may only skip the assets binding / edge cache when it explicitly
 * prefers markdown over HTML and the build's exact markdown manifest includes
 * the route. Missing metadata means a legacy/custom entry, so preserve correct
 * negotiation by falling through as older adapters did.
 */
function wantsRouteMarkdown(
  request: Request,
  markdownManifest: MarkdownManifest | undefined,
  pathname: string,
): boolean {
  return (
    prefersMarkdown(request.headers.get("accept")) &&
    (markdownManifest === undefined || routeSupportsMarkdown(markdownManifest, pathname))
  );
}

function isFetcher(value: unknown): value is CloudflareFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

function isDocumentAssetRequest(
  request: Request,
  markdownManifest: MarkdownManifest | undefined,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return false;
  }

  return !wantsRouteMarkdown(request, markdownManifest, url.pathname);
}

/**
 * The Cache API entry for an ISG page of this build. `caches.default` outlives
 * a deploy, so the key carries the build id: a new version never reads a page
 * the previous one rendered against its own asset hashes. A rollback reads the
 * entries its version wrote. The id sits in the path, not the query, because
 * a zone cache key can ignore query strings. An entry generated before build
 * ids existed keeps its prerender timestamp as the generation.
 */
function createISGCacheKey(
  request: Request,
  pathname: string,
  entry: ISGManifestEntry,
  buildId: string | undefined,
): Request {
  const legacyGeneration =
    typeof entry.generatedAt === "number" && Number.isFinite(entry.generatedAt)
      ? String(entry.generatedAt)
      : null;
  const url = new URL(isgCacheKeyPath(pathname, buildId ?? legacyGeneration), request.url);
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

function isStaleSince(entry: ISGManifestEntry, renderedAt: number): boolean {
  const seconds = getTimeRevalidateSeconds(entry.revalidate);
  if (seconds === null || !Number.isFinite(renderedAt)) return false;
  return Date.now() - renderedAt > seconds * 1000;
}

/**
 * Staleness of the build's own asset, or of a Cache API entry an older release
 * stored as plain HTML with its render time in a header.
 */
function isLegacyCloudflareISGStale(entry: ISGManifestEntry, response: Response): boolean {
  return isStaleSince(
    entry,
    Number(response.headers.get("x-pracht-isg-generated-at")) ||
      entry.generatedAt ||
      Date.parse(response.headers.get("last-modified") ?? ""),
  );
}

/**
 * Serve a Cache API entry an older release stored as plain HTML, until the
 * regeneration it triggers replaces it with a snapshot.
 */
function prepareLegacyCloudflareISGResponse(
  response: Response,
  body: string,
  headersManifest: HeadersManifest,
  pathname: string,
  stale: boolean,
): Response {
  const headers = applyDefaultSecurityHeaders(new Headers(response.headers));
  // Where those entries kept their render's Cache-Control; never sent.
  const legacyCacheControlHeader = "x-pracht-isg-cache-control";
  const documentCacheControl = headers.get(legacyCacheControlHeader);
  headers.delete(legacyCacheControlHeader);
  headers.delete("x-pracht-isg-generated-at");
  // The entry's year-long storage TTL must never reach browsers or a CDN.
  headers.set("cache-control", documentCacheControl || ISG_BROWSER_CACHE_CONTROL);
  headers.delete("age");
  if (documentCacheControl === null) applyHeadersManifest(headers, headersManifest, pathname);
  headers.set("x-pracht-isg", stale ? "stale" : "fresh");
  ensureRouteStateVary(headers);
  return new Response(body, {
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
