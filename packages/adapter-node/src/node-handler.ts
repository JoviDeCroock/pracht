import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  applyDefaultSecurityHeaders,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  hasWebhookRevalidate,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  isCacheableISGResponse,
  jsonResponse,
  type ModuleRegistry,
  PRACHT_REVALIDATE_ENDPOINT,
  PRACHT_REVALIDATE_TOKEN_ENV,
  readRevalidationRequest,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core/server";

import { regenerateISGPage } from "./node-isg.ts";
import { createWebRequest, writeNodeResponseHeaders, writeWebResponse } from "./node-request.ts";
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
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
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

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    const isTransportRouteStateRequest = isRouteStateRequest(url, request.headers);
    const wantsMarkdown = (request.headers.get("accept") ?? "").includes("text/markdown");

    if (url.pathname === PRACHT_REVALIDATE_ENDPOINT) {
      const response = await handleRevalidationEndpoint(request, options, staticDir, isgManifest, {
        request,
        req,
        res,
      });
      await writeWebResponse(res, response);
      return;
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !wantsMarkdown &&
      !isTransportRouteStateRequest
    ) {
      const staticResult = await resolveStaticFile(staticDir, url.pathname, isgManifest);
      if (staticResult) {
        await serveStaticFile(request, res, staticResult, headersManifest, url.pathname);
        return;
      }
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !isTransportRouteStateRequest &&
      !wantsMarkdown &&
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
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    if (
      staticDir &&
      request.method === "GET" &&
      !isTransportRouteStateRequest &&
      url.pathname in isgManifest &&
      response.status === 200 &&
      response.headers.get("content-type")?.includes("text/html") &&
      isCacheableISGResponse(response)
    ) {
      const html = await response.clone().text();
      const htmlPath = resolveContainedPath(staticDir, url.pathname);
      if (htmlPath) {
        await mkdir(dirname(htmlPath), { recursive: true });
        await writeFile(htmlPath, html, "utf-8");
      }
    }

    await writeWebResponse(res, response);
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
  await pipeline(createReadStream(staticResult.filePath), res);
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
      await pipeline(createReadStream(htmlPath), res);
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
  const parsed = await readRevalidationRequest(request, process.env[PRACHT_REVALIDATE_TOKEN_ENV]);
  if (!parsed.ok) return parsed.response;

  if (!staticDir) {
    return jsonResponse(
      {
        error: "ISG revalidation requires a staticDir.",
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
    const entry = isgManifest[pathname];
    const htmlPath = resolveContainedPath(staticDir, pathname);
    if (!entry || !hasWebhookRevalidate(entry.revalidate) || !htmlPath) {
      skipped.push(pathname);
      continue;
    }

    // A failed regeneration keeps the existing on-disk HTML and is reported
    // in `failed` instead of aborting the whole batch with a 500.
    try {
      if (await regenerateISGPage(options, pathname, htmlPath, contextArgs)) {
        revalidated.push(pathname);
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

function isRouteStateRequest(url: URL, headers: Headers): boolean {
  return headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || url.searchParams.get("_data") === "1";
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
