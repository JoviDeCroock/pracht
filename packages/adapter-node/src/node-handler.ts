import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

import {
  applyDefaultSecurityHeaders,
  createBaseRedirectResponse,
  createTrailingSlashRedirectResponse,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  classifyRevalidationSkip,
  createWaitUntilTracker,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  isCacheableISGResponse,
  isMcpResourceMetadataPath,
  jsonResponse,
  matchAppRoute,
  type ModuleRegistry,
  type MarkdownManifest,
  PRACHT_REVALIDATE_ENDPOINT,
  prefersMarkdown,
  preventHeuristicCaching,
  readRevalidationRequest,
  RevalidationReport,
  restoreBasePathInRequest,
  resolveRevalidationToken,
  stripBase,
  type ResolvedApiRoute,
  type PrachtApp,
  routeSupportsMarkdown,
} from "@pracht/core/server";

import {
  COMPRESSION_MIN_SIZE,
  CompressedAssetCache,
  containsEncodedEtag,
  type CompressionState,
  compressBuffer,
  type ContentEncoding,
  createCompressionFileVersion,
  createCompressedStream,
  encodeEtagForEncoding,
  isCompressibleContentType,
  isNotModifiedRequest,
  isTransformableResponse,
  MAX_CACHEABLE_ASSET_SIZE,
  mergeVaryValue,
  negotiateEncoding,
  protectIdentityEtag,
} from "./node-compress.ts";
import {
  createISGRenderInput,
  createISGSnapshotWriteGuard,
  getISGSnapshotHeaders,
  ISGSnapshotWriteError,
  type ISGSnapshotWriteGuard,
  readISGSnapshotHeaders,
  regenerateISGPage,
  writeISGSnapshot,
} from "./node-isg.ts";
import {
  createWebRequest,
  isClientDisconnectError,
  pipeToResponse,
  whenResponseHeadersStaged,
  writeNodeResponseHeaders,
  writeWebResponse,
} from "./node-request.ts";
import type { SharedHeadersManifest } from "@pracht/core/server";
import {
  applyHeadersManifest,
  resolveStaticFile,
  toRouteKey,
  type HeadersManifest,
} from "./node-static.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

export interface NodeAdapterContextArgs {
  request: Request;
  /**
   * The visitor's `node:http` request. While rendering an ISG page it is a
   * detached request mirroring `request` instead: that HTML is shared with
   * every visitor, so it never sees one visitor's cookies or credentials.
   */
  req: IncomingMessage;
  /** The visitor's `node:http` response; detached while rendering an ISG page. */
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
  cssContentManifest?: Record<string, string>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest | SharedHeadersManifest;
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
   * Set when a trusted reverse proxy removes Vite's deploy base from the
   * request pathname before forwarding it. This prevents the framework from
   * mistaking a base-like first route segment for a retained deploy base.
   */
  basePathStripped?: boolean;
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
  /**
   * Compress responses with brotli or gzip based on `Accept-Encoding`
   * (default: `true`). Applies to HTML documents, route-state JSON, and other
   * compressible text types; static assets are compressed at runtime through
   * an in-memory LRU of compressed variants. Set to `false` when a reverse
   * proxy or CDN in front of the server already compresses responses.
   */
  compression?: boolean;
}

/**
 * The `node:http` request listener, plus the handle a graceful shutdown uses
 * to wait for work registered with `waitUntil()`.
 */
export interface NodeRequestHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Wait for every promise registered through `waitUntil()` (and every
   * background ISG regeneration) to settle, for at most `timeoutMs`
   * (default 10s). Resolves `true` when all of it finished in time. Call it
   * after `server.close()` when shutting down.
   */
  drain(timeoutMs?: number): Promise<boolean>;
  /**
   * Close every `text/event-stream` response still open, as if its client
   * had disconnected (the request's `signal` aborts and the body stream is
   * cancelled). Event streams never end on their own, so a graceful shutdown
   * calls this after `server.close()` instead of waiting out its timeout;
   * `EventSource` clients reconnect. Other responses are left to finish.
   * From the first call on, a request that answers with an event stream later
   * is closed as it answers. Resolves once every request in flight has
   * answered and the handlers of the streams it closed have returned, so a
   * `drain()` after it sees the `waitUntil()` work their abort listeners
   * registered; waits at most `timeoutMs` (default 10s).
   */
  closeEventStreams(timeoutMs?: number): Promise<void>;
  /** Registered background work that has not settled yet. */
  readonly pending: number;
}

let warnedAboutMissingCanonicalOrigin = false;

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
): NodeRequestHandler {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;
  const trustProxy = options.trustProxy ?? false;
  const canonicalOrigin = options.canonicalOrigin;
  const maxBodySize = options.maxBodySize;
  const compressionEnabled = options.compression !== false;
  const compressedAssetCache = new CompressedAssetCache();
  const isgWriteGuard = createISGSnapshotWriteGuard();
  // A Node process outlives its responses, so registered work finishes on its
  // own; the tracker is what lets a graceful shutdown wait for it instead of
  // cutting it off.
  const backgroundWork = createWaitUntilTracker();
  const waitUntil = backgroundWork.waitUntil;

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

    const request = await createWebRequest(req, res, { canonicalOrigin, trustProxy, maxBodySize });
    if (request instanceof Response) {
      // 413 or 400: the request never reaches the application.
      await writeWebResponse(res, request);
      return;
    }
    // A stripped upstream pathname is a route path, not a public URL. Testing
    // it for the bare deploy base would make a route equal to that base segment
    // unreachable (`/app/app` arrives as `/app` behind an `/app/` mount). The
    // proxy owns the public `/app` -> `/app/` redirect in this mode.
    const baseRedirect = options.basePathStripped ? null : createBaseRedirectResponse(request);
    if (baseRedirect) {
      await writeWebResponse(res, baseRedirect);
      return;
    }
    const url = new URL(request.url);
    const mcpAuth = options.app.agents?.mcp?.auth;
    const isMcpMetadataRequest =
      mcpAuth !== undefined && isMcpResourceMetadataPath(url.pathname, mcpAuth);
    // Static files and manifests are keyed by base-free route paths. A trusted
    // proxy may already have removed the base; otherwise strip it here while
    // preserving the public URL on the Request passed to application code.
    const routePathname = options.basePathStripped ? url.pathname : stripBase(url.pathname);
    const compression: CompressionState | undefined = compressionEnabled
      ? { cache: compressedAssetCache, request }
      : undefined;
    // Locations carry the public URL, deploy base included, even when a proxy
    // forwarded the request without it.
    const redirectToCanonicalPage = (): Response | null =>
      createTrailingSlashRedirectResponse(
        options.basePathStripped ? restoreBasePathInRequest(request) : request,
      );
    // ISG entries are keyed by route path; `/about/` is the same page.
    const isgKey = routePathname === null ? null : toRouteKey(routePathname);
    const isTransportRouteStateRequest = isRouteStateRequest(url, request.headers);
    // Only routes that can actually answer with markdown skip the static and
    // ISG fast paths: the client has to prefer markdown over HTML (a browser's
    // `*/*` or a q-weighted `text/markdown;q=0.1` does not), and the route has
    // to appear in the exact markdown manifest emitted by the build. Missing
    // metadata means a legacy/custom entry, so preserve correct negotiation by
    // falling through as older adapters did.
    const wantsMarkdown =
      prefersMarkdown(request.headers.get("accept")) &&
      (options.markdownManifest === undefined ||
        (routePathname !== null && routeSupportsMarkdown(options.markdownManifest, routePathname)));

    if (routePathname === PRACHT_REVALIDATE_ENDPOINT) {
      const response = await handleRevalidationEndpoint(
        request,
        options,
        staticDir,
        isgManifest,
        compression,
        waitUntil,
      );
      await writeWebResponse(res, response, compression);
      return;
    }

    if (
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !isMcpMetadataRequest &&
      !wantsMarkdown &&
      !isTransportRouteStateRequest &&
      routePathname !== null
    ) {
      const staticResult = await resolveStaticFile(staticDir, routePathname, isgManifest);
      // A prerendered page answers one spelling under `pracht({ trailingSlash })`.
      const trailingSlashRedirect = staticResult?.document ? redirectToCanonicalPage() : null;
      if (trailingSlashRedirect) {
        await writeWebResponse(res, trailingSlashRedirect);
        return;
      }
      if (staticResult) {
        await serveStaticFile(
          request,
          res,
          staticResult,
          headersManifest,
          isgManifest,
          routePathname,
          compression,
        );
        return;
      }
    }

    // An ISG document request is answered from the snapshot, or rendered into
    // one. Either way the HTML is shared, so it is rendered without the
    // visitor's request.
    const isgDocumentKey =
      staticDir &&
      isStaticAssetMethod(request.method) &&
      !isMcpMetadataRequest &&
      !isTransportRouteStateRequest &&
      !wantsMarkdown &&
      isgKey !== null &&
      isgKey in isgManifest
        ? isgKey
        : null;

    if (staticDir && isgDocumentKey !== null) {
      const trailingSlashRedirect = redirectToCanonicalPage();
      if (trailingSlashRedirect) {
        await writeWebResponse(res, trailingSlashRedirect);
        return;
      }
      const served = await serveISGEntry(
        request,
        res,
        options,
        staticDir,
        isgDocumentKey,
        isgManifest[isgDocumentKey],
        headersManifest,
        compression,
        waitUntil,
        isgWriteGuard,
      );
      if (served) return;
    }

    let applicationRequest: Request;
    let context: TContext | undefined;
    let finishIsgRender: (() => void) | undefined;
    if (isgDocumentKey !== null) {
      // The transport still answers the visitor's own preconditions.
      createApplicationRequest(request, compression);
      // Cold miss: no snapshot on disk yet. Render the page everyone will be
      // served, not this visitor's version of it.
      ({
        request: applicationRequest,
        context,
        finish: finishIsgRender,
      } = await createISGRenderInput(options, isgDocumentKey, request));
    } else {
      applicationRequest = createApplicationRequest(request, compression);
      if (options.basePathStripped) {
        applicationRequest = restoreBasePathInRequest(applicationRequest);
      }
      context = options.createContext
        ? await options.createContext({ request: applicationRequest, req, res })
        : undefined;
    }

    try {
      const response = await handlePrachtRequest({
        app: options.app,
        // The adapter restored the public pathname before exposing this Request
        // to createContext or the framework runtime.
        basePathStripped: false,
        context,
        registry: options.registry,
        request: applicationRequest,
        apiRoutes: options.apiRoutes,
        clientEntryUrl: options.clientEntryUrl,
        islandsEntryUrl: options.islandsEntryUrl,
        islandsBootstrapRequired: options.islandsBootstrapRequired,
        cssManifest: options.cssManifest,
        cssContentManifest: options.cssContentManifest,
        jsManifest: options.jsManifest,
        waitUntil,
      } satisfies HandlePrachtRequestOptions<TContext>);

      const isIsgDocument =
        staticDir !== undefined &&
        request.method === "GET" &&
        isgDocumentKey !== null &&
        response.status === 200 &&
        (response.headers.get("content-type")?.includes("text/html") ?? false) &&
        isCacheableISGResponse(response);

      if (isIsgDocument) {
        const html = await response.clone().text();
        const htmlPath = resolveContainedPath(staticDir, isgDocumentKey);
        if (htmlPath) {
          try {
            await writeISGSnapshot(
              htmlPath,
              html,
              getISGSnapshotHeaders(response, new URL(applicationRequest.url).pathname),
            );
            compressedAssetCache.invalidatePath(htmlPath);
          } catch (error) {
            // The render succeeded; an unwritable static directory must not
            // turn it into a 500. The next request renders again.
            isgWriteGuard.failed(htmlPath, error);
          }
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
        compression,
      );
    } finally {
      finishIsgRender?.();
    }
  };

  // `http.createServer(handler)` ignores the returned promise, so a rejection
  // here would become an unhandled rejection and terminate the process. Every
  // failure has to be absorbed at this boundary.
  // Each open response with the promise of the request serving it.
  const openResponses = new Map<ServerResponse, Promise<void>>();
  const closedEventStreams = new Set<Promise<void>>();
  let closingEventStreams = false;
  const closeIfEventStream = (res: ServerResponse, served: Promise<void>): void => {
    if (res.writableEnded || res.destroyed) return;
    // Response headers are staged before the first body chunk, so a stream
    // that has not sent an event yet is closed as well.
    const contentType = String(res.getHeader("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("text/event-stream")) return;
    res.destroy();
    closedEventStreams.add(served);
  };
  // A request still answering may answer with an event stream, so it is
  // checked once its headers are staged.
  const closeOnceAnswered = (res: ServerResponse, served: Promise<void>): Promise<void> =>
    Promise.race([whenResponseHeadersStaged(res), served]).then(() =>
      closeIfEventStream(res, served),
    );
  const listener = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const served = serve(req, res);
    openResponses.set(res, served);
    res.once("close", () => openResponses.delete(res));
    if (closingEventStreams) void closeOnceAnswered(res, served);
    return served;
  };
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
        // Header selection happens before a streamed body starts. If that body
        // fails before sending bytes, discard every staged header from the
        // abandoned response so the plain fallback is not mislabeled as
        // brotli/gzip (or cached with the abandoned response's metadata).
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        res.statusCode = 500;
        res.statusMessage = "Internal Server Error";
        writeNodeResponseHeaders(
          res,
          applyDefaultSecurityHeaders(
            new Headers({
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            }),
          ),
        );
        res.end("Internal Server Error");
      } catch {
        res.destroy();
      }
    }
  };

  return Object.defineProperties(listener, {
    drain: { value: (timeoutMs?: number) => backgroundWork.drain(timeoutMs) },
    closeEventStreams: {
      value: async (timeoutMs = 10_000) => {
        closingEventStreams = true;
        const deadline = Date.now() + timeoutMs;
        await untilDeadline(
          Promise.all(Array.from(openResponses, ([res, served]) => closeOnceAnswered(res, served))),
          deadline,
        );
        await untilDeadline(Promise.all(closedEventStreams), deadline);
        // Let close and abort listeners queued by the last response run.
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
      },
    },
    pending: { get: () => backgroundWork.pending },
  }) as NodeRequestHandler;
}

/** Wait for `promise`, but no later than `deadline` (epoch ms). */
async function untilDeadline(promise: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, Math.max(0, deadline - Date.now()));
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  headersManifest: HeadersManifest | SharedHeadersManifest,
  isgManifest: Record<string, ISGManifestEntry>,
  pathname: string,
  compression: CompressionState | undefined,
): Promise<void> {
  const file = await open(staticResult.filePath, "r");
  try {
    const fileStat = await file.stat();
    const compressionGeneration = compression?.cache.getPathGeneration(staticResult.filePath) ?? 0;
    const compressionFileVersion = compression ? createCompressionFileVersion(fileStat) : undefined;
    const headers = applyDefaultSecurityHeaders(
      new Headers({
        "content-type": staticResult.contentType,
        "cache-control": staticResult.cacheControl,
        etag: createWeakEtag(fileStat),
        "last-modified": fileStat.mtime.toUTCString(),
        "accept-ranges": "bytes",
      }),
    );
    // `/page/index.html` names an ISG snapshot's file directly.
    const snapshotHeaders =
      (pathname.replace(/\/index\.html$/, "") || "/") in isgManifest
        ? await readISGSnapshotHeaders(staticResult.filePath, fileStat)
        : null;
    applySnapshotOrManifestHeaders(headers, snapshotHeaders, headersManifest, pathname);
    const encoding = negotiateFileEncoding(request, headers, fileStat.size, compression);

    if (isNotModified(request, headers, compressionGeneration === 0)) {
      res.statusCode = 304;
      writeNodeHeaders(res, headers);
      res.end();
      return;
    }

    // Ranges are served from the identity representation only; a request
    // with a Range header is never compressed (see negotiateFileEncoding).
    // A digest of the whole body cannot describe a slice of it, so files that
    // carry one are always sent whole.
    const range =
      request.method === "GET" &&
      encoding === null &&
      !headers.has("content-digest") &&
      !headers.has("content-md5")
        ? resolveByteRange(request, headers, fileStat.size)
        : null;
    if (range === "unsatisfiable") {
      res.statusCode = 416;
      headers.set("content-range", `bytes */${fileStat.size}`);
      headers.set("content-length", "0");
      writeNodeHeaders(res, headers);
      res.end();
      return;
    }
    if (range) {
      res.statusCode = 206;
      headers.set("content-range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
      headers.set("content-length", String(range.end - range.start + 1));
      writeNodeHeaders(res, headers);
      await pipeToResponse(
        file.createReadStream({ start: range.start, end: range.end, autoClose: false }),
        res,
      );
      return;
    }

    res.statusCode = 200;
    writeNodeHeaders(res, headers);
    if (request.method === "HEAD") {
      await writeFileHead(
        res,
        staticResult.filePath,
        file,
        fileStat,
        encoding,
        compression,
        compressionFileVersion,
        compressionGeneration,
      );
      return;
    }
    await writeFileBody(
      res,
      staticResult.filePath,
      file,
      fileStat,
      encoding,
      compression,
      compressionFileVersion,
      compressionGeneration,
    );
  } finally {
    await file.close();
  }
}

/**
 * Decide the on-the-wire encoding for a file response and stamp the
 * compression headers. Mutates `headers` before the conditional-request check
 * so the `ETag` the client revalidates against always names the encoded
 * variant it was served — encoded and identity variants never share a
 * validator.
 */
function negotiateFileEncoding(
  request: Request,
  headers: Headers,
  fileSize: number,
  compression: CompressionState | undefined,
): ContentEncoding | null {
  if (!compression) return null;

  const identityEtag = headers.get("etag");
  if (identityEtag) headers.set("etag", protectIdentityEtag(identityEtag));
  if (
    !isCompressibleContentType(headers.get("content-type")) ||
    !isTransformableResponse(200, headers)
  ) {
    return null;
  }

  // The representation varies by Accept-Encoding even when this response goes
  // out as identity (small file today, larger after the next deploy).
  headers.set("vary", mergeVaryValue(headers.get("vary")));

  // The application needs the original validators to decide whether and which
  // byte range to serve. Keep the entire request identity-encoded even when it
  // ignores an invalid/unsupported Range and answers with a full 200, otherwise
  // that identity decision could be relabeled as a compressed representation.
  if (request.headers.has("range")) return null;

  if (fileSize < COMPRESSION_MIN_SIZE) {
    return null;
  }

  const encoding = negotiateEncoding(compression.request.headers.get("accept-encoding"));
  if (!encoding) return null;

  headers.set("content-encoding", encoding);
  // A manifest can carry the identity representation's Content-Length. The
  // buffered path below replaces it with the exact encoded length; the
  // streaming path must use chunked transfer instead.
  headers.delete("content-length");
  if (identityEtag) headers.set("etag", encodeEtagForEncoding(identityEtag, encoding));
  return encoding;
}

/**
 * Stream a file body, compressed when an encoding was negotiated. Files up to
 * `MAX_CACHEABLE_ASSET_SIZE` are compressed once at high quality and served
 * from an in-memory LRU keyed by path + durable file identity + local write
 * generation, so hashed assets and (re)generated ISG documents pay the
 * compression cost once per version. The open handle binds the bytes to the
 * metadata and validator selected by the caller even if the path is replaced
 * concurrently. Larger files stream through zlib per request.
 */
async function writeFileBody(
  res: ServerResponse,
  filePath: string,
  file: FileHandle,
  fileStat: { mtimeMs: number; size: number },
  encoding: ContentEncoding | null,
  compression: CompressionState | undefined,
  compressionFileVersion: string | undefined,
  compressionGeneration: number,
): Promise<void> {
  if (!encoding || !compression || !compressionFileVersion) {
    await pipeToResponse(file.createReadStream({ autoClose: false }), res);
    return;
  }

  const pending = getBufferedCompressedFile(
    filePath,
    file,
    fileStat,
    encoding,
    compression,
    compressionFileVersion,
    compressionGeneration,
  );
  if (pending) {
    const compressed = await pending;
    res.setHeader("content-length", compressed.byteLength);
    res.end(compressed);
    return;
  }

  await pipeToResponse(
    createCompressedStream(file.createReadStream({ autoClose: false }), encoding, {
      sizeHint: fileStat.size,
    }),
    res,
  );
}

function getBufferedCompressedFile(
  filePath: string,
  file: FileHandle,
  fileStat: { mtimeMs: number; size: number },
  encoding: ContentEncoding,
  compression: CompressionState,
  compressionFileVersion: string,
  compressionGeneration: number,
): Promise<Buffer> | null {
  if (fileStat.size > MAX_CACHEABLE_ASSET_SIZE) return null;

  const key = `${filePath}\0${compressionFileVersion}\0${compressionGeneration}\0${encoding}`;
  return compression.cache.getOrCompress(key, fileStat.size, async () =>
    compressBuffer(await file.readFile(), encoding),
  );
}

async function writeFileHead(
  res: ServerResponse,
  filePath: string,
  file: FileHandle,
  fileStat: { mtimeMs: number; size: number },
  encoding: ContentEncoding | null,
  compression: CompressionState | undefined,
  compressionFileVersion: string | undefined,
  compressionGeneration: number,
): Promise<void> {
  const pending =
    encoding && compression && compressionFileVersion
      ? getBufferedCompressedFile(
          filePath,
          file,
          fileStat,
          encoding,
          compression,
          compressionFileVersion,
          compressionGeneration,
        )
      : null;
  if (pending) {
    const compressed = await pending;
    res.setHeader("content-length", compressed.byteLength);
  }
  res.end();
}

async function serveISGEntry<TContext>(
  request: Request,
  res: ServerResponse,
  options: NodeAdapterOptions<TContext>,
  staticDir: string,
  pathname: string,
  entry: ISGManifestEntry,
  headersManifest: HeadersManifest | SharedHeadersManifest,
  compression: CompressionState | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
  writeGuard: ISGSnapshotWriteGuard,
): Promise<boolean> {
  const htmlPath = resolveContainedPath(staticDir, pathname);
  if (!htmlPath) return false;

  const file = await open(htmlPath, "r").catch(() => null);
  if (!file) return false;

  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) return false;
    const compressionGeneration = compression?.cache.getPathGeneration(htmlPath) ?? 0;
    const compressionFileVersion = compression ? createCompressionFileVersion(fileStat) : undefined;

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
    const snapshotHeaders = await readISGSnapshotHeaders(htmlPath, fileStat);
    applySnapshotOrManifestHeaders(headers, snapshotHeaders, headersManifest, pathname);
    await applyCompressionContentValidator(
      headers,
      htmlPath,
      file,
      fileStat.size,
      compressionFileVersion,
      compressionGeneration,
      compression,
    );
    headers.set("x-pracht-isg", isStale ? "stale" : "fresh");

    const encoding = negotiateFileEncoding(request, headers, fileStat.size, compression);

    if (isNotModified(request, headers, compression === undefined)) {
      res.statusCode = 304;
      writeNodeHeaders(res, headers);
      res.end();
    } else {
      res.statusCode = 200;
      writeNodeHeaders(res, headers);
      if (request.method === "HEAD") {
        await writeFileHead(
          res,
          htmlPath,
          file,
          fileStat,
          encoding,
          compression,
          compressionFileVersion,
          compressionGeneration,
        );
      } else {
        await writeFileBody(
          res,
          htmlPath,
          file,
          fileStat,
          encoding,
          compression,
          compressionFileVersion,
          compressionGeneration,
        );
      }
    }

    if (isStale && writeGuard.canRegenerate(htmlPath)) {
      // Tracked like application `waitUntil()` work, so a graceful shutdown
      // lets an in-flight regeneration finish writing its snapshot.
      waitUntil(
        regenerateISGPageAndInvalidateCache(
          options,
          pathname,
          htmlPath,
          request,
          compression,
          waitUntil,
        ).then(
          () => writeGuard.succeeded(htmlPath),
          (err) => {
            if (err instanceof ISGSnapshotWriteError) {
              writeGuard.failed(htmlPath, err, (revalidateSeconds ?? 0) * 1000);
            } else {
              console.error(`ISG regeneration failed for ${pathname}:`, err);
            }
          },
        ),
      );
    }

    return true;
  } finally {
    await file.close();
  }
}

async function handleRevalidationEndpoint<TContext>(
  request: Request,
  options: NodeAdapterOptions<TContext>,
  staticDir: string | undefined,
  isgManifest: Record<string, ISGManifestEntry>,
  compression: CompressionState | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
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

  const report = new RevalidationReport("instance");

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
      if (
        await regenerateISGPageAndInvalidateCache(
          options,
          pathname,
          htmlPath!,
          request,
          compression,
          waitUntil,
        )
      ) {
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

async function regenerateISGPageAndInvalidateCache<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  origin: Request,
  compression: CompressionState | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  const regenerated = await regenerateISGPage(options, pathname, htmlPath, origin, waitUntil);
  if (regenerated) compression?.cache.invalidatePath(htmlPath);
  return regenerated;
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

/**
 * A regenerated ISG snapshot is served with the headers it was rendered with;
 * the build's headers belong to the build's HTML.
 */
function applySnapshotOrManifestHeaders(
  headers: Headers,
  snapshotHeaders: Record<string, string> | null,
  headersManifest: HeadersManifest | SharedHeadersManifest,
  pathname: string,
): void {
  if (!snapshotHeaders) {
    applyHeadersManifest(headers, headersManifest, pathname);
    return;
  }
  for (const [name, value] of Object.entries(snapshotHeaders)) headers.set(name, value);
}

/**
 * The single byte range a `GET` asks for. Returns `null` to serve the whole
 * file: no or malformed `Range`, several ranges, a unit other than `bytes`,
 * or an `If-Range` that no longer matches (a weak `ETag` never does).
 */
function resolveByteRange(
  request: Request,
  headers: Headers,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const header = request.headers.get("range");
  if (!header) return null;

  const ifRange = request.headers.get("if-range")?.trim();
  if (ifRange) {
    const etag = headers.get("etag");
    const matches = ifRange.startsWith('"')
      ? etag !== null && !etag.startsWith("W/") && etag === ifRange
      : !ifRange.startsWith("W/") && ifRange === headers.get("last-modified");
    if (!matches) return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  if (match[2] !== "" && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  return { start, end: Math.min(end, size - 1) };
}

function isRouteStateRequest(url: URL, headers: Headers): boolean {
  return headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || url.searchParams.get("_data") === "1";
}

/**
 * Dynamic compression owns conditional validation after it has selected the
 * outgoing representation and escaped its reserved validator namespace. Do
 * not let an application short-circuit against the source identity metadata
 * before either step happens.
 */
function createApplicationRequest(
  request: Request,
  compression: CompressionState | undefined,
): Request {
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (
    !compression ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    request.headers.has("range") ||
    (!ifMatch && !ifNoneMatch && !request.headers.has("if-modified-since")) ||
    (!negotiateEncoding(request.headers.get("accept-encoding")) &&
      !containsEncodedEtag(ifMatch) &&
      !containsEncodedEtag(ifNoneMatch))
  ) {
    return request;
  }

  const headers = new Headers(request.headers);
  if (ifMatch) {
    compression.ownsIfMatch = true;
    headers.delete("if-match");
    // If-Match takes precedence, so the recipient must ignore
    // If-Unmodified-Since rather than exposing it alone to the application.
    headers.delete("if-unmodified-since");
  }
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(request, { headers });
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

async function applyCompressionContentValidator(
  headers: Headers,
  filePath: string,
  file: FileHandle,
  fileSize: number,
  compressionFileVersion: string | undefined,
  compressionGeneration: number,
  compression: CompressionState | undefined,
): Promise<void> {
  if (!compressionFileVersion || !compression) return;
  const key = `${filePath}\0${compressionFileVersion}\0${compressionGeneration}`;
  const pending = compression.cache.getOrCreateFileEtag(key, fileSize, () =>
    createFileContentEtag(file),
  );
  if (!pending) {
    // The stat-derived fallback can alias a same-size rewrite on a coarse
    // filesystem. Omit the validator under load instead of advertising one we
    // cannot prove names these bytes.
    headers.delete("etag");
    return;
  }
  headers.set("etag", await pending);
}

async function createFileContentEtag(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;

  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return `W/"pracht-file-${hash.digest("base64url")}"`;
}

function isNotModified(request: Request, headers: Headers, allowLastModified = true): boolean {
  // A sub-second/coarse-filesystem rewrite can retain its HTTP-date while its
  // in-memory generation and ETag advance. In that case only the ETag can
  // safely validate the selected representation.
  return isNotModifiedRequest(
    request,
    headers.get("etag"),
    allowLastModified ? headers.get("last-modified") : null,
  );
}
