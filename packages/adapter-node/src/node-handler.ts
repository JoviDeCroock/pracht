import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";

import {
  applyDefaultSecurityHeaders,
  bypassesPrerenderedDocument,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  classifyRevalidationSkip,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  isCacheableISGResponse,
  jsonResponse,
  isRouteStateTransportRequest,
  matchAppRoute,
  type ModuleRegistry,
  type MarkdownManifest,
  PRACHT_REVALIDATE_ENDPOINT,
  preventHeuristicCaching,
  readRevalidationRequest,
  RevalidationReport,
  resolveRevalidationToken,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core/server";

import { regenerateISGPage } from "./node-isg.ts";
import {
  createWebRequest,
  isClientDisconnectError,
  pipeToResponse,
  writeNodeResponseHeaders,
  writeWebResponse,
} from "./node-request.ts";
import { applyHeadersManifest, resolveStaticFile, type HeadersManifest } from "./node-static.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

export interface NodeAdapterContextArgs {
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeAdapterOptions<TContext = unknown> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  staticDir?: string;
  viteManifest?: unknown;
  isgManifest?: Record<string, ISGManifestEntry>;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit to preserve negotiation for legacy/custom entries. */
  markdownManifest?: MarkdownManifest;
  createContext?: (args: NodeAdapterContextArgs) => TContext | Promise<TContext>;
  /**
   * Canonical public origin for request URL construction. When set, the Node
   * adapter ignores `Host` / forwarded host headers and always builds
   * `request.url` against this origin.
   */
  canonicalOrigin?: string;
  /**
   * Whether to trust proxy headers (`Forwarded`, `X-Forwarded-Proto`,
   * `X-Forwarded-Host`) when constructing the request URL.
   *
   * When `canonicalOrigin` is set, it takes precedence and these headers are
   * ignored for URL construction.
   *
   * When **false** (the default) and no `canonicalOrigin` is set, the request
   * URL is derived from the socket: protocol is inferred from TLS state, and
   * host from the `Host` header. Forwarded headers are ignored.
   *
   * When **true**, forwarded headers are honored with the following precedence:
   *   1. RFC 7239 `Forwarded` header (`proto=` and `host=` directives)
   *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
   *   3. Socket-derived values (fallback)
   *
   * Enable this only when the Node server sits behind a trusted reverse proxy
   * (e.g. nginx, Cloudflare, a load balancer) that sets these headers.
   */
  trustProxy?: boolean;
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBodySize?: number;
}

let warnedAboutMissingCanonicalOrigin = false;

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;
  const trustProxy = options.trustProxy ?? false;
  const canonicalOrigin = options.canonicalOrigin;
  const maxBodySize = options.maxBodySize;

  if (maxBodySize !== undefined && (!Number.isInteger(maxBodySize) || maxBodySize <= 0)) {
    throw new Error("nodeAdapter({ maxBodySize }) expects a positive integer number of bytes.");
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!canonicalOrigin && shouldWarnAboutMissingCanonicalOrigin(staticDir)) {
      warnedAboutMissingCanonicalOrigin = true;
      console.warn(
        "[pracht] @pracht/adapter-node is deriving request.url from Host headers. Set nodeAdapter({ canonicalOrigin }) for deployed Node apps to avoid host-header poisoning.",
      );
    }

    let request: Request;
    try {
      request = await createWebRequest(req, { canonicalOrigin, trustProxy, maxBodySize });
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }
    const url = new URL(request.url);
    const isTransportRouteStateRequest = isRouteStateTransportRequest(request);
    const bypassesPrerender = bypassesPrerenderedDocument(
      request,
      options.markdownManifest,
      options.app.markdown,
    );

    if (url.pathname === PRACHT_REVALIDATE_ENDPOINT) {
      const response = await handleRevalidationEndpoint(request, options, staticDir, isgManifest, {
        request,
        req,
        res,
      });
      await writeWebResponse(res, response);
      return;
    }

    if (staticDir && isStaticAssetMethod(request.method) && !bypassesPrerender) {
      const staticResult = await resolveStaticFile(staticDir, url.pathname, isgManifest);
      if (staticResult) {
        await serveStaticFile(request, res, staticResult, headersManifest, url.pathname);
        return;
      }
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !bypassesPrerender &&
      url.pathname in isgManifest
    ) {
      const served = await serveISGEntry(
        request,
        res,
        options,
        staticDir,
        url.pathname,
        isgManifest[url.pathname],
        headersManifest,
        { request, req, res },
      );
      if (served) return;
    }

    const context = options.createContext
      ? await options.createContext({ request, req, res })
      : undefined;

    const response = await handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    const isIsgDocument =
      staticDir !== undefined &&
      request.method === "GET" &&
      !isTransportRouteStateRequest &&
      url.pathname in isgManifest &&
      response.status === 200 &&
      (response.headers.get("content-type")?.includes("text/html") ?? false) &&
      isCacheableISGResponse(response);

    if (isIsgDocument) {
      const html = await response.clone().text();
      const htmlPath = resolveContainedPath(staticDir, url.pathname);
      if (htmlPath) {
        await mkdir(dirname(htmlPath), { recursive: true });
        await writeFile(htmlPath, html, "utf-8");
      }
    }

    // Evaluated after the ISG snapshot decision above: stamping a
    // `Cache-Control` first would make `isCacheableISGResponse()` reject the
    // very response it was about to persist. A reverse proxy or CDN in front of
    // a Node deployment can otherwise apply heuristic freshness to an
    // authenticated SSR page — the same hazard the Cloudflare adapter guards.
    //
    // ISG documents are exempt. This response is the cold render of a page that
    // every later request answers from disk with
    // `public, max-age=0, must-revalidate`; stamping only the cold one would
    // make a route's caching headers depend on whether its snapshot exists yet.
    await writeWebResponse(
      res,
      isIsgDocument ? response : preventHeuristicCaching(request, response),
    );
  };

  // `http.createServer(handler)` ignores the returned promise, so a rejection
  // here would become an unhandled rejection and terminate the process. Every
  // failure has to be absorbed at this boundary.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(req, res);
    } catch (error) {
      // A disconnect-shaped error code is not on its own evidence that the
      // client left: `createContext`, a loader, or a pooled database client can
      // all throw `Error { code: "ECONNRESET" }` from a *server-side* socket.
      // Only skip the error path when the connection is genuinely unusable,
      // otherwise a real failure would return without ever ending the response
      // and the request would hang until `server.requestTimeout`.
      const connectionGone = req.destroyed || res.destroyed || !res.writable;
      if (connectionGone && isClientDisconnectError(error)) {
        if (!res.destroyed) res.destroy();
        return;
      }

      console.error("[pracht] Unhandled error while serving a request:", error);

      if (res.destroyed || res.headersSent || res.writableEnded) {
        // Either nothing can be written any more, or the client already has a
        // partial response and appending a 500 body would corrupt it.
        if (!res.destroyed) res.destroy();
        return;
      }

      try {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      } catch {
        res.destroy();
      }
    }
  };
}

function shouldWarnAboutMissingCanonicalOrigin(staticDir: string | undefined): boolean {
  if (warnedAboutMissingCanonicalOrigin) return false;
  if (process.env.NODE_ENV === "production") return true;
  return typeof staticDir === "string" && staticDir.length > 0;
}

async function serveStaticFile(
  request: Request,
  res: ServerResponse,
  staticResult: { filePath: string; contentType: string; cacheControl: string },
  headersManifest: HeadersManifest,
  pathname: string,
): Promise<void> {
  const fileStat = await stat(staticResult.filePath);
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": staticResult.contentType,
      "cache-control": staticResult.cacheControl,
      etag: createWeakEtag(fileStat),
      "last-modified": fileStat.mtime.toUTCString(),
    }),
  );
  if (staticResult.contentType.includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, pathname);
  }

  if (isNotModified(request, headers)) {
    res.statusCode = 304;
    writeNodeHeaders(res, headers);
    res.end();
    return;
  }

  res.statusCode = 200;
  writeNodeHeaders(res, headers);
  if (request.method === "HEAD") {
    res.end();
    return;
  }
  await pipeToResponse(createReadStream(staticResult.filePath), res);
}

async function serveISGEntry<TContext>(
  request: Request,
  res: ServerResponse,
  options: NodeAdapterOptions<TContext>,
  staticDir: string,
  pathname: string,
  entry: ISGManifestEntry,
  headersManifest: HeadersManifest,
  contextArgs: NodeAdapterContextArgs,
): Promise<boolean> {
  const htmlPath = resolveContainedPath(staticDir, pathname);
  if (!htmlPath) return false;

  const fileStat = await stat(htmlPath).catch(() => null);
  if (!fileStat?.isFile()) return false;

  const ageMs = Date.now() - fileStat.mtimeMs;
  const revalidateSeconds = getTimeRevalidateSeconds(entry.revalidate);
  const isStale = revalidateSeconds !== null && ageMs > revalidateSeconds * 1000;

  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      etag: createWeakEtag(fileStat),
      "last-modified": fileStat.mtime.toUTCString(),
      vary: ROUTE_STATE_REQUEST_HEADER,
    }),
  );
  applyHeadersManifest(headers, headersManifest, pathname);
  headers.set("x-pracht-isg", isStale ? "stale" : "fresh");

  if (isNotModified(request, headers)) {
    res.statusCode = 304;
    writeNodeHeaders(res, headers);
    res.end();
  } else {
    res.statusCode = 200;
    writeNodeHeaders(res, headers);
    if (request.method === "HEAD") {
      res.end();
    } else {
      await pipeToResponse(createReadStream(htmlPath), res);
    }
  }

  if (isStale) {
    regenerateISGPage(options, pathname, htmlPath, contextArgs).catch((err) => {
      console.error(`ISG regeneration failed for ${pathname}:`, err);
    });
  }

  return true;
}

async function handleRevalidationEndpoint<TContext>(
  request: Request,
  options: NodeAdapterOptions<TContext>,
  staticDir: string | undefined,
  isgManifest: Record<string, ISGManifestEntry>,
  contextArgs: NodeAdapterContextArgs,
): Promise<Response> {
  const parsed = await readRevalidationRequest(request, resolveRevalidationToken());
  if (!parsed.ok) return parsed.response;

  if (!staticDir) {
    // Built through the shared report so this reply has the same shape as every
    // other one, `details` included, rather than the three legacy arrays alone.
    const unavailable = new RevalidationReport();
    for (const pathname of parsed.paths) unavailable.skipped(pathname, "not_prerendered");
    return jsonResponse(
      { error: "ISG revalidation requires a staticDir.", ...unavailable.toJSON() },
      503,
    );
  }

  const report = new RevalidationReport();

  for (const pathname of parsed.paths) {
    try {
      const entry = isgManifest[pathname];
      const htmlPath = resolveContainedPath(staticDir, pathname);
      const skip = classifyRevalidationSkip(
        entry && { render: "isg", revalidate: entry.revalidate },
        htmlPath !== null,
        matchAppRoute(options.app, pathname)?.route ?? null,
      );
      if (skip) {
        report.skipped(pathname, skip);
        continue;
      }

      // A failed regeneration keeps the existing on-disk HTML and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (await regenerateISGPage(options, pathname, htmlPath!, contextArgs)) {
        report.revalidated(pathname);
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
 * Resolve a URL pathname to `<staticDir>/<pathname>/index.html` while
 * ensuring the result stays inside `staticDir`. Returns `null` when the
 * pathname would escape the root (`..`, encoded separators, NUL bytes,
 * etc.), which the caller treats as a miss. Also rejects NUL — Node
 * filesystem APIs throw on these but it's clearer to bail early.
 */
function resolveContainedPath(staticDir: string, pathname: string): string | null {
  if (pathname.includes("\0")) return null;

  const rootResolved = resolve(staticDir);
  const candidate =
    pathname === "/"
      ? join(rootResolved, "index.html")
      : resolve(rootResolved, `.${pathname}`, "index.html");
  const resolved = resolve(candidate);

  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    return null;
  }
  return resolved;
}

function isStaticAssetMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function writeNodeHeaders(res: ServerResponse, headers: Headers): void {
  writeNodeResponseHeaders(res, headers);
}

function createWeakEtag(fileStat: { mtimeMs: number; size: number }): string {
  return `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
}

function isNotModified(request: Request, headers: Headers): boolean {
  const etag = headers.get("etag");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (etag && ifNoneMatch) {
    const candidates = ifNoneMatch.split(",").map((value) => value.trim());
    if (candidates.includes("*") || candidates.includes(etag)) {
      return true;
    }
  }

  const lastModified = headers.get("last-modified");
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (lastModified && ifModifiedSince) {
    const modifiedTime = Date.parse(lastModified);
    const sinceTime = Date.parse(ifModifiedSince);
    if (!Number.isNaN(modifiedTime) && !Number.isNaN(sinceTime) && modifiedTime <= sinceTime) {
      return true;
    }
  }

  return false;
}
